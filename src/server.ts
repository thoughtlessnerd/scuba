import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { WebSocketServer, type WebSocket } from 'ws';
import os from 'node:os';
import { SessionManager } from './sessions.js';
import { TelegramManager, type TelegramChat, type TelegramMessage, type MediaKind } from './telegram.js';
import type { ClientMessage, ServerMessage, TelegramServerEvent } from './protocol.js';
import { AgentStore } from './agent-store.js';
import { AgentManager } from './agent-manager.js';
import { PromptRouter } from './prompt-router.js';
import { prepareMotherCwd } from './mother-setup.js';
import { Settings, type PermissionMode } from './settings.js';
import { dispatchCommand, buildReadyMessage, telegramCommandManifest } from './bot-commands.js';

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
  await telegram.start();
  // Register slash commands so Telegram's autocomplete + tap-to-fill in DMs
  // omits the @botname suffix (groups always append it for disambiguation).
  void telegram.setMyCommands(telegramCommandManifest());

  const store = new AgentStore();
  const settings = new Settings(store);
  const agents = new AgentManager(mgr, store, settings);

  // Pre-write mother's MCP config so bootstrap's --resume of a saved mother
  // sees the scuba MCP server. No-op if mother isn't configured yet.
  if (process.env.MOTHER_TELEGRAM_CHAT_ID?.trim()) {
    try { prepareMotherCwd(process.env.MOTHER_CWD, opts.port); } catch (err) {
      console.error('[agent] prepareMotherCwd failed:', (err as Error).message);
    }
  }

  // Mother is spawned manually via POST /api/agent/mother. If she's already in
  // the DB, bootstrap() below will restore her PTY via --resume.
  const motherChatId = (process.env.MOTHER_TELEGRAM_CHAT_ID ?? '').trim();

  // Send a "ready" greeting + command list to the bound chat for every
  // mother/adhoc spawn. Covers fresh spawns, bootstrap respawns, and /restart.
  // Listener must be attached BEFORE bootstrap() since spawned is deferred via
  // setImmediate and fires after bootstrap's await resolves.
  //
  // Greeting is delayed ~3.5s to outlast respawnFromRecord's exit watchdog
  // (3s): if a --resume fails, the PTY exits and the record is deleted before
  // we'd send the greeting. We re-check the terminal is alive at fire time.
  const READY_GREETING_DELAY_MS = 3500;
  agents.on('spawned', (terminalId: string) => {
    const initial = agents.getTerminal(terminalId);
    if (!initial) return;
    const { role, chatId } = initial.record;
    if (role !== 'mother' && role !== 'adhoc') return;
    if (!chatId) return;
    if (!telegram.enabled) return;
    setTimeout(() => {
      const term = agents.getTerminal(terminalId);
      if (!term) return; // PTY died / record removed in the meantime
      telegram
        .sendMessage(chatId, buildReadyMessage(term))
        .catch((err) => console.warn(`[agent] ready greeting send failed for ${term.record.name}:`, (err as Error).message));
    }, READY_GREETING_DELAY_MS);
  });

  await agents.bootstrap();
  const promptRouter = new PromptRouter(agents, telegram, store);
  promptRouter.start();
  if (motherChatId) {
    const existing = store.getMother();
    if (existing) console.log(`[agent] mother restored from db (chat ${existing.chatId})`);

    // Mother-chat-only legacy commands (kept for backward compat — not in the
    // generic command registry because they don't fit the "act on the bound
    // terminal" model).
    telegram.on('message', async (m: TelegramMessage) => {
      if (m.from !== 'user') return;
      if (m.chatId !== motherChatId) return;
      const text = (m.text ?? '').trim();
      if (text === '/respawn-all') {
        const { restarted } = agents.restartAll();
        void telegram.sendMessage(motherChatId, `respawned ${restarted} terminal(s).`);
        return;
      }
      if (text === '/clear-mother') {
        const ok = agents.typeIntoMother('/clear\r');
        void telegram.sendMessage(motherChatId, ok ? 'mother context cleared.' : 'mother not alive.');
        return;
      }
    });
  } else {
    console.log('[agent] MOTHER_TELEGRAM_CHAT_ID not set — mother disabled');
  }

  // Generic routing for every user message. Slash commands defined in the
  // bot-commands registry act on the terminal bound to the chat (mother or
  // adhoc). Non-command text goes into the bound terminal's input queue.
  telegram.on('message', async (m: TelegramMessage) => {
    if (m.from !== 'user') return;
    const text = (m.text ?? '').trim();
    if (!text) return;

    // Legacy mother-only commands above were handled by a separate listener;
    // skip re-handling them here.
    if (m.chatId === motherChatId && (text === '/respawn-all' || text === '/clear-mother')) return;

    if (text.startsWith('/')) {
      const handled = await dispatchCommand(text, m.chatId, motherChatId || null, agents, telegram);
      if (handled) return;
      // Unknown command — fall through, treat as input.
    }

    if (motherChatId && m.chatId === motherChatId) {
      const enqueued = agents.enqueueForMother(text);
      if (!enqueued) console.warn('[agent] mother chat got message but mother is not alive');
      return;
    }
    agents.enqueueForAdhocChat(m.chatId, text);
  });

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
    // If this is an agent terminal (mother or worker), route through agent-manager
    // so the DB row is removed too. Without this, bootstrap on next server start
    // would --resume her and she'd come back from the dead.
    if (agents.getTerminal(req.params.id)) {
      const ok = agents.killTerminal(req.params.id);
      res.status(ok ? 204 : 404).end();
      return;
    }
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

  // ----- agent tool endpoints (consumed by the MCP subprocess) -----

  app.get('/api/agent/chats', (_req, res) => {
    res.json(
      telegram.listChats().map((c) => ({
        chatId: c.chatId,
        title: c.title ?? c.label ?? c.chatId,
        type: c.type,
      })),
    );
  });

  app.get('/api/agent/groups', (_req, res) => {
    res.json(agents.listGroups());
  });

  app.post('/api/agent/groups', (req, res) => {
    try {
      const { name, color, taskDescription } = req.body ?? {};
      if (typeof name !== 'string' || !name.trim()) {
        res.status(400).json({ error: 'name required' });
        return;
      }
      res.json(agents.createGroup({ name, color, taskDescription }));
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.get('/api/agent/bound-chats', (_req, res) => {
    // chatIds in use by any live agent terminal (mother, worker, adhoc).
    // Used by the New-claude modal to hide already-bound chats from the picker.
    const bound = new Set<string>();
    for (const t of agents.listTerminals()) {
      if (t.record.chatId) bound.add(t.record.chatId);
    }
    res.json({ chatIds: Array.from(bound) });
  });

  app.get('/api/agent/terminals', (req, res) => {
    const groupId = typeof req.query.groupId === 'string' ? req.query.groupId : undefined;
    const list = agents.listTerminals();
    const out = list
      .filter((t) => (groupId ? t.record.groupId === groupId : true))
      .map((t) => ({
        ...t.record,
        state: t.detector.getState(),
      }));
    res.json(out);
  });

  app.post('/api/agent/terminals', (req, res) => {
    try {
      const { cwd, name, groupId, chatId, systemPrompt, initialTask } = req.body ?? {};
      if (typeof cwd !== 'string' || !cwd.trim()) throw new Error('cwd required');
      if (typeof name !== 'string' || !name.trim()) throw new Error('name required');
      const effectivePrompt =
        typeof systemPrompt === 'string' && systemPrompt.trim().length > 0
          ? systemPrompt
          : settings.get('workerSystemPrompt');
      const t = agents.spawnWorker({
        cwd: cwd.trim(),
        name: name.trim(),
        groupId: groupId ?? null,
        chatId: chatId ?? null,
        systemPrompt: effectivePrompt,
        initialTask,
      });
      res.json({ ...t.record, state: t.detector.getState() });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.delete('/api/agent/terminals/:id', (req, res) => {
    const ok = agents.killTerminal(req.params.id);
    res.status(ok ? 204 : 404).end();
  });

  app.post('/api/agent/terminals/:id/send', (req, res) => {
    try {
      const text = String(req.body?.text ?? '');
      if (!text) throw new Error('text required');
      agents.sendToWorker(req.params.id, text);
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.get('/api/agent/terminals/:id/tail', (req, res) => {
    const t = agents.getTerminal(req.params.id);
    if (!t) {
      res.status(404).end();
      return;
    }
    const lines = Math.max(1, Math.min(200, Number(req.query.lines ?? 40)));
    res.json({ state: t.detector.getState(), tail: t.detector.getTail(lines) });
  });

  app.get('/api/agent/mother', (_req, res) => {
    const rec = store.getMother();
    if (!rec) {
      res.json({ alive: false, configured: Boolean(motherChatId) });
      return;
    }
    const live = agents.getTerminal(rec.id);
    res.json({
      alive: Boolean(live),
      configured: Boolean(motherChatId),
      record: rec,
      state: live?.detector.getState() ?? null,
    });
  });

  app.post('/api/agent/mother', (_req, res) => {
    try {
      if (!motherChatId) throw new Error('MOTHER_TELEGRAM_CHAT_ID is not set in .env');
      const cwd = prepareMotherCwd(process.env.MOTHER_CWD, opts.port);
      const t = agents.spawnMother({
        cwd,
        chatId: motherChatId,
        systemPrompt: settings.get('motherSystemPrompt'),
      });
      res.json({ ...t.record, state: t.detector.getState() });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.post('/api/agent/adhoc', (req, res) => {
    try {
      const { cwd, chatId, name } = req.body ?? {};
      if (typeof cwd !== 'string' || !cwd.trim()) throw new Error('cwd required');
      if (typeof chatId !== 'string' || !chatId.trim()) throw new Error('chatId required');
      if (motherChatId && chatId.trim() === motherChatId) {
        throw new Error("can't bind adhoc claude to mother's chat");
      }
      const t = agents.spawnAdhoc({
        cwd: cwd.trim(),
        chatId: chatId.trim(),
        name: typeof name === 'string' ? name : undefined,
        systemPrompt: settings.get('adhocSystemPrompt'),
      });
      res.json({ ...t.record, state: t.detector.getState() });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.get('/api/settings', (_req, res) => {
    res.json({ values: settings.values(), defaults: settings.defaults });
  });

  app.patch('/api/settings', (req, res) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const patch: Parameters<Settings['update']>[0] = {};
      if (typeof body.motherSystemPrompt === 'string') patch.motherSystemPrompt = body.motherSystemPrompt;
      if (typeof body.workerSystemPrompt === 'string') patch.workerSystemPrompt = body.workerSystemPrompt;
      if (typeof body.adhocSystemPrompt === 'string') patch.adhocSystemPrompt = body.adhocSystemPrompt;
      if (body.permissionMode === 'acceptEdits' || body.permissionMode === 'bypassPermissions') {
        patch.permissionMode = body.permissionMode as PermissionMode;
      }
      if (body.turnEndDebounceMs !== undefined) {
        patch.turnEndDebounceMs = Number(body.turnEndDebounceMs);
      }
      const next = settings.update(patch);
      res.json({ values: next, defaults: settings.defaults });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.post('/api/agent/ask-human', async (req, res) => {
    try {
      if (!motherChatId) throw new Error('mother chat not configured');
      const text = String(req.body?.text ?? '');
      if (!text.trim()) throw new Error('text required');
      const msg = await telegram.sendMessage(motherChatId, text);
      res.json({ messageId: msg.id });
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
      const onResize = (cols: number, rows: number) => {
        // Keep the state detector's headless terminal in sync with the PTY's
        // actual size, otherwise long option lines wrap differently in the
        // detector vs claude's rendering and the parser misses them.
        agents.getTerminal(id)?.detector.resize(cols, rows);
      };
      attachSession(ws, session.pty, session.buffer, onResize);
    });
  });

  await new Promise<void>((resolve) => server.listen(opts.port, opts.host, resolve));
  return server;
}

function attachSession(
  ws: import('ws').WebSocket,
  proc: import('node-pty').IPty,
  replay: string,
  onResize?: (cols: number, rows: number) => void,
) {
  const send = (msg: ServerMessage) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  };

  // Replay recent output so the client's xterm renders the current screen
  // immediately on (re)attach. This is what restores the visible state after
  // a browser refresh — works for any TUI (shell, vim, claude code) because
  // we're literally re-feeding xterm the same bytes it would have rendered.
  if (replay && replay.length > 0) send({ type: 'output', data: replay });

  const dataSub = proc.onData((data) => send({ type: 'output', data }));
  const exitSub = proc.onExit(({ exitCode, signal }) => {
    send({ type: 'exit', code: exitCode, signal });
    ws.close();
  });

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
      onResize?.(msg.cols, msg.rows);
    }
  });

  ws.on('close', () => {
    dataSub.dispose();
    exitSub.dispose();
  });
}
