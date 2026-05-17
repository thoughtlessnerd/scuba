import { randomUUID } from 'node:crypto';
import os from 'node:os';
import { existsSync, statSync } from 'node:fs';
import pty, { type IPty } from 'node-pty';
import type {
  CreateGroupRequest,
  CreateSessionRequest,
  GroupInfo,
  SessionInfo,
  UpdateGroupRequest,
  UpdateSessionRequest,
} from './protocol.js';

const DEFAULT_SHELL =
  process.env.SHELL || (process.platform === 'win32' ? 'powershell.exe' : '/bin/bash');

const DEFAULT_GROUP_COLOR = '#7aa2f7';

export interface Session {
  info: SessionInfo;
  pty: IPty;
  /** Recent PTY output, capped. Replayed on each WS attach to restore the visible screen. */
  buffer: string;
}

const BUFFER_CAP = 256 * 1024;

export class SessionManager {
  private sessions = new Map<string, Session>();
  private groups = new Map<string, GroupInfo>();
  private groupOrder = 0;

  createSession(req: CreateSessionRequest): Session {
    const cwd = resolveCwd(req.cwd);
    const shell = req.shell || DEFAULT_SHELL;
    const groupId = this.normalizeGroupId(req.groupId);

    const proc = pty.spawn(shell, [], {
      name: 'xterm-256color',
      cwd,
      env: process.env as Record<string, string>,
      cols: req.cols ?? 80,
      rows: req.rows ?? 24,
    });

    const id = randomUUID();
    const info: SessionInfo = {
      id,
      cwd,
      shell,
      createdAt: Date.now(),
      hidden: false,
      groupId,
    };
    const session: Session = { info, pty: proc, buffer: '' };
    this.attachBuffer(session);

    proc.onExit(() => this.sessions.delete(id));
    this.sessions.set(id, session);
    return session;
  }

  private attachBuffer(session: Session): void {
    session.pty.onData((data) => {
      session.buffer = (session.buffer + data).slice(-BUFFER_CAP);
    });
  }

  /** Register a PTY spawned outside SessionManager (e.g. by AgentManager). */
  registerSession(pty: IPty, info: SessionInfo): Session {
    const session: Session = { info, pty, buffer: '' };
    this.attachBuffer(session);
    pty.onExit(() => this.sessions.delete(info.id));
    this.sessions.set(info.id, session);
    return session;
  }

  /** Create an empty group with a caller-chosen id (used by AgentManager to mirror DB groups). */
  registerGroup(info: GroupInfo): GroupInfo {
    this.groups.set(info.id, info);
    return info;
  }

  getSession(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  listSessions(): SessionInfo[] {
    return Array.from(this.sessions.values()).map((s) => s.info);
  }

  updateSession(id: string, patch: UpdateSessionRequest): SessionInfo | undefined {
    const s = this.sessions.get(id);
    if (!s) return undefined;
    if (patch.name !== undefined) {
      const trimmed = patch.name.trim();
      s.info.name = trimmed === '' ? undefined : trimmed;
    }
    if (patch.hidden !== undefined) s.info.hidden = !!patch.hidden;
    if (patch.groupId !== undefined) s.info.groupId = this.normalizeGroupId(patch.groupId);
    return s.info;
  }

  killSession(id: string): boolean {
    const s = this.sessions.get(id);
    if (!s) return false;
    s.pty.kill();
    this.sessions.delete(id);
    return true;
  }

  killAll(): void {
    for (const s of this.sessions.values()) s.pty.kill();
    this.sessions.clear();
  }

  createGroup(req: CreateGroupRequest): GroupInfo {
    const id = randomUUID();
    const info: GroupInfo = {
      id,
      name: (req.name && req.name.trim()) || 'New group',
      color: req.color || DEFAULT_GROUP_COLOR,
      type: req.type || 'tabs',
      hidden: false,
      order: ++this.groupOrder,
    };
    this.groups.set(id, info);
    return info;
  }

  listGroups(): GroupInfo[] {
    return Array.from(this.groups.values()).sort((a, b) => a.order - b.order);
  }

  updateGroup(id: string, patch: UpdateGroupRequest): GroupInfo | undefined {
    const g = this.groups.get(id);
    if (!g) return undefined;
    if (patch.name !== undefined) {
      const trimmed = patch.name.trim();
      g.name = trimmed === '' ? 'Untitled' : trimmed;
    }
    if (patch.color !== undefined) g.color = patch.color;
    if (patch.type !== undefined) g.type = patch.type;
    if (patch.hidden !== undefined) g.hidden = !!patch.hidden;
    return g;
  }

  deleteGroup(id: string): boolean {
    if (!this.groups.has(id)) return false;
    for (const s of this.sessions.values()) {
      if (s.info.groupId === id) s.info.groupId = null;
    }
    this.groups.delete(id);
    return true;
  }

  private normalizeGroupId(input: string | null | undefined): string | null {
    if (!input) return null;
    return this.groups.has(input) ? input : null;
  }
}

function resolveCwd(input?: string): string {
  if (!input || input.trim() === '') return os.homedir();
  const expanded = input.startsWith('~')
    ? input.replace(/^~/, os.homedir())
    : input;
  if (!existsSync(expanded) || !statSync(expanded).isDirectory()) {
    throw new Error(`cwd is not a directory: ${expanded}`);
  }
  return expanded;
}
