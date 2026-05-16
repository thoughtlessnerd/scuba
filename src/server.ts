import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { WebSocketServer } from 'ws';
import { SessionManager } from './sessions.js';
import type { ClientMessage, ServerMessage } from './protocol.js';

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

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '', `http://${req.headers.host}`);
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

  ws.on('message', (raw) => {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.type === 'input') proc.write(msg.data);
    else if (msg.type === 'resize') proc.resize(msg.cols, msg.rows);
  });

  ws.on('close', () => {
    dataSub.dispose();
    exitSub.dispose();
  });
}
