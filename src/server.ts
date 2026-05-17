import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { WebSocketServer, type WebSocket } from 'ws';
import { SessionManager } from './sessions.js';
import { TelegramManager, type TelegramChat, type TelegramMessage, type MediaKind } from './telegram.js';
import type { ClientMessage, ServerMessage, TelegramServerEvent } from './protocol.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface ServerOptions {
  host: string;
  port: number;
  dev: boolean;
}

export async function startServer(opts: ServerOptions): Promise<http.Server> {
  const app = express();
  app.use(express.json());

  const mgr = new SessionManager();
  const telegram = new TelegramManager(process.env.TELEGRAM_BOT_TOKEN);
  void telegram.start();

  app.get('/api/sessions', (_req, res) => {
    res.json(mgr.listSessions());
  });

  app.post('/api/sessions', (req, res) => {
    try {
      const { info } = mgr.createSession(req.body ?? {});
      res.json(info);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.patch('/api/sessions/:id', (req, res) => {
    const info = mgr.updateSession(req.params.id, req.body ?? {});
    if (!info) {
      res.status(404).end();
      return;
    }
    res.json(info);
  });

  app.delete('/api/sessions/:id', (req, res) => {
    const ok = mgr.killSession(req.params.id);
    res.status(ok ? 204 : 404).end();
  });

  app.get('/api/groups', (_req, res) => {
    res.json(mgr.listGroups());
  });

  app.post('/api/groups', (req, res) => {
    res.json(mgr.createGroup(req.body ?? {}));
  });

  app.patch('/api/groups/:id', (req, res) => {
    const info = mgr.updateGroup(req.params.id, req.body ?? {});
    if (!info) {
      res.status(404).end();
      return;
    }
    res.json(info);
  });

  app.delete('/api/groups/:id', (req, res) => {
    const ok = mgr.deleteGroup(req.params.id);
    res.status(ok ? 204 : 404).end();
  });

  app.get('/api/telegram/status', (_req, res) => {
    res.json({ enabled: telegram.enabled, bot: telegram.botInfo });
  });

  app.get('/api/telegram/chats', (_req, res) => {
    res.json(telegram.listChats());
  });

  app.post('/api/telegram/chats', async (req, res) => {
    if (!telegram.enabled) {
      res.status(503).json({ error: 'telegram not configured' });
      return;
    }
    try {
      const { chatId, label } = req.body ?? {};
      const chat = await telegram.addChatVerified(String(chatId ?? ''), label);
      res.json(chat);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.delete('/api/telegram/chats/:chatId', (req, res) => {
    const ok = telegram.removeChat(req.params.chatId);
    res.status(ok ? 204 : 404).end();
  });

  app.delete('/api/telegram/chats/:chatId/messages', (req, res) => {
    const ok = telegram.clearMessages(req.params.chatId);
    res.status(ok ? 204 : 404).end();
  });

  app.post('/api/telegram/chats/:chatId/refresh', async (req, res) => {
    const chat = await telegram.refreshChatMeta(req.params.chatId);
    if (!chat) {
      res.status(404).end();
      return;
    }
    res.json(chat);
  });

  app.get('/api/telegram/chats/:chatId/messages', (req, res) => {
    res.json(telegram.getMessages(req.params.chatId));
  });

  app.post('/api/telegram/chats/:chatId/send-media', async (req, res) => {
    try {
      const kind = String(req.query.kind ?? 'document') as MediaKind;
      const filename = String(req.query.filename ?? 'upload');
      const caption = req.query.caption ? String(req.query.caption) : undefined;
      const mimeType = req.headers['content-type'] || 'application/octet-stream';
      const chunks: Buffer[] = [];
      let total = 0;
      const MAX = 50 * 1024 * 1024;
      req.on('data', (c: Buffer) => {
        total += c.length;
        if (total > MAX) {
          req.destroy(new Error('payload too large'));
          return;
        }
        chunks.push(c);
      });
      req.on('end', async () => {
        try {
          const buf = Buffer.concat(chunks);
          if (buf.length === 0) {
            res.status(400).json({ error: 'empty body' });
            return;
          }
          const msg = await telegram.sendMedia(req.params.chatId, kind, buf, filename, mimeType, caption);
          res.json(msg);
        } catch (err) {
          res.status(400).json({ error: (err as Error).message });
        }
      });
      req.on('error', (err) => {
        res.status(400).json({ error: err.message });
      });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.get('/api/telegram/files/:fileId', async (req, res) => {
    try {
      const { stream, contentType, size } = await telegram.fetchFile(req.params.fileId);
      res.setHeader('Content-Type', contentType);
      if (size) res.setHeader('Content-Length', String(size));
      res.setHeader('Cache-Control', 'private, max-age=3600');
      stream.on('error', () => { try { res.end(); } catch {} });
      stream.pipe(res);
    } catch (err) {
      res.status(404).json({ error: (err as Error).message });
    }
  });

  app.post('/api/telegram/chats/:chatId/send', async (req, res) => {
    try {
      const text = String(req.body?.text ?? '');
      if (!text.trim()) {
        res.status(400).json({ error: 'text required' });
        return;
      }
      const msg = await telegram.sendMessage(req.params.chatId, text);
      res.json(msg);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  if (opts.dev) {
    app.get('/', (_req, res) => res.redirect('http://localhost:5173'));
  } else {
    const webDist = path.resolve(__dirname, '..', 'web-dist');
    if (existsSync(webDist)) {
      app.use(express.static(webDist));
      app.get('*', (_req, res) => res.sendFile(path.join(webDist, 'index.html')));
    }
  }

  const server = http.createServer(app);
  const wss = new WebSocketServer({ noServer: true });
  const telegramClients = new Set<WebSocket>();

  const broadcastTelegram = (evt: TelegramServerEvent) => {
    const data = JSON.stringify(evt);
    for (const ws of telegramClients) {
      if (ws.readyState === ws.OPEN) ws.send(data);
    }
  };

  telegram.on('message', (m: TelegramMessage) => broadcastTelegram({ type: 'message', message: m }));
  telegram.on('chat:add', (c: TelegramChat) => broadcastTelegram({ type: 'chat:add', chat: c }));
  telegram.on('chat:update', (c: TelegramChat) => broadcastTelegram({ type: 'chat:update', chat: c }));
  telegram.on('chat:remove', ({ chatId }: { chatId: string }) =>
    broadcastTelegram({ type: 'chat:remove', chatId }),
  );

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '', `http://${req.headers.host}`);
    if (url.pathname === '/ws/telegram') {
      wss.handleUpgrade(req, socket, head, (ws) => {
        telegramClients.add(ws);
        const hello: TelegramServerEvent = {
          type: 'hello',
          enabled: telegram.enabled,
          bot: telegram.botInfo,
        };
        ws.send(JSON.stringify(hello));
        ws.on('close', () => telegramClients.delete(ws));
      });
      return;
    }
    const match = url.pathname.match(/^\/ws\/sessions\/([^/]+)$/);
    if (!match) {
      socket.destroy();
      return;
    }
    const id = match[1];
    const session = mgr.getSession(id);
    if (!session) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      attachSession(ws, session.pty);
    });
  });

  await new Promise<void>((resolve) => server.listen(opts.port, opts.host, resolve));
  return server;
}

function attachSession(ws: import('ws').WebSocket, proc: import('node-pty').IPty) {
  const send = (msg: ServerMessage) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  };

  const dataSub = proc.onData((data) => send({ type: 'output', data }));
  const exitSub = proc.onExit(({ exitCode, signal }) => {
    send({ type: 'exit', code: exitCode, signal });
    ws.close();
  });

  let nudged = false;
  ws.on('message', (raw) => {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.type === 'input') proc.write(msg.data);
    else if (msg.type === 'resize') {
      proc.resize(msg.cols, msg.rows);
      if (!nudged) {
        nudged = true;
        setTimeout(() => {
          try { proc.write('\x0c'); } catch {}
        }, 30);
      }
    }
  });

  ws.on('close', () => {
    dataSub.dispose();
    exitSub.dispose();
  });
}
