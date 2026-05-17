import { randomUUID } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import pty, { type IPty } from 'node-pty';
import type { SessionInfo, GroupInfo } from './protocol.js';
import type { SessionManager } from './sessions.js';
import {
  AgentStore,
  type AgentRole,
  type AgentTerminalRecord,
  type AgentGroupRecord,
} from './agent-store.js';
import { PtyStateDetector, type AwaitingChoiceInfo, type StateTransitionEvent } from './pty-state.js';

const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 40;
const DEFAULT_GROUP_COLOR = '#9ece6a';

export interface SpawnWorkerOptions {
  cwd: string;
  name: string;
  groupId: string | null;
  chatId: string | null;
  systemPrompt: string;
  initialTask?: string;
}

export interface SpawnMotherOptions {
  cwd: string;
  chatId: string;
  systemPrompt: string;
  name?: string;
}

export interface CreateGroupOptions {
  name: string;
  color?: string;
  taskDescription?: string;
}

export interface AgentTerminal {
  record: AgentTerminalRecord;
  pty: IPty;
  detector: PtyStateDetector;
  queue: string[];          // pending input lines to send when terminal is ready
  draining: boolean;
  /** Set when we write input. Cleared on turn-end (idle/ready after working). */
  hadInputSinceTurnEnd: boolean;
}

export interface AgentManagerEvents {
  awaitingChoice: (terminalId: string, info: AwaitingChoiceInfo) => void;
  idle: (terminalId: string) => void;
  transition: (terminalId: string, evt: StateTransitionEvent) => void;
  exit: (terminalId: string, exitCode: number) => void;
}

export class AgentManager extends EventEmitter {
  private terminals = new Map<string, AgentTerminal>();

  constructor(
    private readonly sessions: SessionManager,
    private readonly store: AgentStore,
  ) {
    super();
  }

  /** On scuba startup: recreate groups in SessionManager and respawn all terminals via --resume. */
  async bootstrap(): Promise<void> {
    // Clean up orphan groups from prior sessions (group created, worker never
    // landed or was killed). At runtime we keep groups around briefly; at boot
    // any group with zero terminals is dead weight.
    for (const g of this.store.listGroups()) {
      const inGroup = this.store.listTerminals({ groupId: g.id });
      if (inGroup.length === 0) {
        this.store.deleteGroup(g.id);
        console.log(`[agent] cleaned up empty group "${g.name}"`);
      }
    }

    let order = 0;
    for (const g of this.store.listGroups()) {
      const info: GroupInfo = {
        id: g.id,
        name: g.name,
        color: g.color,
        type: 'tiled',
        hidden: false,
        order: ++order,
      };
      this.sessions.registerGroup(info);
    }
    for (const rec of this.store.listTerminals()) {
      try {
        this.respawnFromRecord(rec);
      } catch (err) {
        console.error(`[agent] failed to respawn terminal ${rec.id} (${rec.name}):`, (err as Error).message);
      }
    }
  }

  shutdown(): void {
    for (const t of this.terminals.values()) {
      try { t.pty.kill(); } catch {}
      t.detector.destroy();
    }
    this.terminals.clear();
  }

  // ---------- groups ----------

  createGroup(opts: CreateGroupOptions): AgentGroupRecord {
    const id = randomUUID();
    const rec: AgentGroupRecord = {
      id,
      name: opts.name.trim() || 'task',
      color: opts.color ?? DEFAULT_GROUP_COLOR,
      taskDescription: opts.taskDescription ?? '',
      createdAt: Date.now(),
    };
    this.store.insertGroup(rec);
    this.sessions.registerGroup({
      id: rec.id,
      name: rec.name,
      color: rec.color,
      type: 'tiled',
      hidden: false,
      order: Date.now(),
    });
    return rec;
  }

  listGroups(): AgentGroupRecord[] {
    return this.store.listGroups();
  }

  // ---------- spawn ----------

  spawnWorker(opts: SpawnWorkerOptions): AgentTerminal {
    const cwd = resolveCwd(opts.cwd);
    const claudeSessionId = randomUUID();
    const id = randomUUID();
    const args = [
      '--session-id', claudeSessionId,
      '--permission-mode', 'acceptEdits',
      '-n', opts.name,
      '--system-prompt', opts.systemPrompt,
    ];
    const proc = pty.spawn('claude', args, {
      name: 'xterm-256color',
      cwd,
      env: process.env as Record<string, string>,
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
    });

    const record: AgentTerminalRecord = {
      id,
      claudeSessionId,
      cwd,
      name: opts.name,
      groupId: opts.groupId,
      chatId: opts.chatId,
      systemPrompt: opts.systemPrompt,
      role: 'worker',
      createdAt: Date.now(),
    };
    this.store.insertTerminal(record);

    const term = this.registerSpawn(proc, record);

    if (opts.initialTask && opts.initialTask.trim().length > 0) {
      this.enqueueInput(id, opts.initialTask);
    }
    return term;
  }

  spawnMother(opts: SpawnMotherOptions): AgentTerminal {
    const existing = this.store.getMother();
    if (existing) {
      const live = this.terminals.get(existing.id);
      if (live) return live;
      // Stale record — the PTY died (server restart with no usable session
      // snapshot, crash, etc). Clear it and spawn fresh; the user clicking
      // "Spawn mother" expects a working mother, not another resume attempt.
      this.store.deleteTerminal(existing.id);
    }

    const cwd = resolveCwd(opts.cwd);
    const claudeSessionId = randomUUID();
    const id = randomUUID();
    const name = opts.name ?? 'mother';
    const args = [
      '--session-id', claudeSessionId,
      '--permission-mode', 'acceptEdits',
      '-n', name,
      '--system-prompt', opts.systemPrompt,
    ];
    const proc = pty.spawn('claude', args, {
      name: 'xterm-256color',
      cwd,
      env: process.env as Record<string, string>,
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
    });

    const record: AgentTerminalRecord = {
      id,
      claudeSessionId,
      cwd,
      name,
      groupId: null,
      chatId: opts.chatId,
      systemPrompt: opts.systemPrompt,
      role: 'mother',
      createdAt: Date.now(),
    };
    this.store.insertTerminal(record);
    return this.registerSpawn(proc, record);
  }

  /** Respawn an existing record via `claude --resume`. Used at boot and after explicit restart. */
  respawnFromRecord(rec: AgentTerminalRecord): AgentTerminal {
    const cwd = resolveCwd(rec.cwd);
    const args = [
      '--resume', rec.claudeSessionId,
      '--permission-mode', 'acceptEdits',
      '-n', rec.name,
      '--system-prompt', rec.systemPrompt,
    ];
    const proc = pty.spawn('claude', args, {
      name: 'xterm-256color',
      cwd,
      env: process.env as Record<string, string>,
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
    });

    // If --resume bails out (session not persisted, claude version mismatch,
    // etc), the process exits within ~1s with a non-zero code. Clean the dead
    // record so the next user action can spawn fresh instead of looping.
    const spawnedAt = Date.now();
    proc.onExit(({ exitCode }) => {
      if (exitCode !== 0 && Date.now() - spawnedAt < 3000) {
        console.error(
          `[agent] respawn of "${rec.name}" failed (exit ${exitCode}). Removing stale record.`,
        );
        this.store.deleteTerminal(rec.id);
      }
    });

    return this.registerSpawn(proc, rec);
  }

  /** Kill all live PTYs (keep DB rows) and respawn each via --resume. Used by /respawn-all. */
  restartAll(): { restarted: number } {
    const records = Array.from(this.terminals.values()).map((t) => t.record);
    // Add any records not currently live (e.g. crashed earlier).
    const liveIds = new Set(records.map((r) => r.id));
    for (const r of this.store.listTerminals()) {
      if (!liveIds.has(r.id)) records.push(r);
    }
    for (const t of this.terminals.values()) {
      try { t.pty.kill(); } catch {}
      t.detector.destroy();
    }
    this.terminals.clear();

    let restarted = 0;
    for (const rec of records) {
      try {
        this.respawnFromRecord(rec);
        restarted++;
      } catch (err) {
        console.error(`[agent] restart failed for ${rec.name}:`, (err as Error).message);
      }
    }
    return { restarted };
  }

  killTerminal(id: string): boolean {
    const t = this.terminals.get(id);
    if (!t) return false;
    const groupId = t.record.groupId;
    try { t.pty.kill(); } catch {}
    t.detector.destroy();
    this.terminals.delete(id);
    this.store.deleteTerminal(id);

    // If this was the last terminal in its group, delete the group too.
    if (groupId) {
      const remaining = this.store.listTerminals({ groupId });
      if (remaining.length === 0) {
        this.store.deleteGroup(groupId);
        this.sessions.deleteGroup(groupId);
      }
    }
    return true;
  }

  // ---------- input ----------

  /** Direct write to a worker by mother's send_to_terminal tool. Throws if blocked. */
  sendToWorker(id: string, text: string): void {
    const t = this.terminals.get(id);
    if (!t) throw new Error(`unknown terminal: ${id}`);
    if (t.record.role !== 'worker') throw new Error('can only send_to_terminal to workers');
    if (t.detector.getState() === 'awaiting-choice') {
      throw new Error(`worker ${t.record.name} is awaiting human input; cannot write to it`);
    }
    this.enqueueInput(id, text);
  }

  /** Bare-prompt check used by enqueueInput's "drain immediately if ready" branch. */
  private isReadyForInput(state: string): boolean {
    return state === 'ready' || state === 'idle';
  }

  /** Used by Telegram bridge for mother chat. Queue + drain when idle. */
  enqueueForMother(text: string): boolean {
    const mother = this.store.getMother();
    if (!mother) return false;
    if (!this.terminals.has(mother.id)) return false;
    this.enqueueInput(mother.id, text);
    return true;
  }

  /** Used by Telegram bridge for inline-keyboard callback. Writes raw digit + Enter immediately. */
  answerAwaitingChoice(id: string, choice: number): boolean {
    const t = this.terminals.get(id);
    if (!t) return false;
    if (t.detector.getState() !== 'awaiting-choice') return false;
    t.pty.write(`${choice}\r`);
    return true;
  }

  /** For the /clear-mother command. */
  typeIntoMother(literal: string): boolean {
    const mother = this.store.getMother();
    if (!mother) return false;
    const t = this.terminals.get(mother.id);
    if (!t) return false;
    t.pty.write(literal);
    return true;
  }

  // ---------- introspection ----------

  getTerminal(id: string): AgentTerminal | undefined {
    return this.terminals.get(id);
  }

  listTerminals(): AgentTerminal[] {
    return Array.from(this.terminals.values());
  }

  // ---------- internals ----------

  private registerSpawn(proc: IPty, rec: AgentTerminalRecord): AgentTerminal {
    const info: SessionInfo = {
      id: rec.id,
      cwd: rec.cwd,
      shell: 'claude',
      createdAt: rec.createdAt,
      name: rec.name,
      hidden: false,
      groupId: rec.groupId,
    };
    this.sessions.registerSession(proc, info);

    const detector = new PtyStateDetector({ cols: DEFAULT_COLS, rows: DEFAULT_ROWS });
    const term: AgentTerminal = {
      record: rec,
      pty: proc,
      detector,
      queue: [],
      draining: false,
      hadInputSinceTurnEnd: false,
    };
    this.terminals.set(rec.id, term);

    proc.onData((data) => {
      detector.push(data);
    });
    proc.onExit(({ exitCode, signal }) => {
      console.log(
        `[agent] terminal "${rec.name}" (${rec.role}) exited code=${exitCode} signal=${signal ?? '-'}`,
      );
      detector.destroy();
      this.terminals.delete(rec.id);
      this.emit('exit', rec.id, exitCode);
    });

    detector.on('transition', (evt: StateTransitionEvent) => {
      this.emit('transition', rec.id, evt);
      if (evt.to === 'awaiting-choice' && evt.awaiting) {
        this.emit('awaitingChoice', rec.id, evt.awaiting);
      }
      // Both `ready` and `idle` mean the prompt is bare and we can write into it.
      // Drain queued input as soon as the terminal is ready — no need to wait 60s.
      if (evt.to === 'ready' || evt.to === 'idle') {
        this.drainQueue(rec.id);

        // Turn-end: working → ready/idle AND we wrote input since last turn-end.
        // Mother chat gets a screenshot of the response. Workers nudge mother
        // through their own path; they don't post directly.
        if (evt.from === 'working' && term.hadInputSinceTurnEnd) {
          term.hadInputSinceTurnEnd = false;
          if (rec.role === 'mother') this.emit('turnEnd', rec.id);
        }
      }
      if (evt.to === 'idle') {
        this.emit('idle', rec.id);
        if (rec.role === 'worker') this.notifyMotherOfIdle(rec.id);
      }
    });

    return term;
  }

  private enqueueInput(id: string, text: string): void {
    const t = this.terminals.get(id);
    if (!t) return;
    t.queue.push(text);
    if (this.isReadyForInput(t.detector.getState())) this.drainQueue(id);
  }

  private drainQueue(id: string): void {
    const t = this.terminals.get(id);
    if (!t || t.draining) return;
    if (t.queue.length === 0) return;
    t.draining = true;
    try {
      // Send one queued item per idle. Claude consumes the input and goes "working";
      // we'll come back here on the next idle transition.
      const next = t.queue.shift()!;
      writeAsPaste(t.pty, next);
      t.hadInputSinceTurnEnd = true;
    } finally {
      t.draining = false;
    }
  }

  private notifyMotherOfIdle(workerId: string): void {
    const worker = this.terminals.get(workerId);
    const mother = this.store.getMother();
    if (!worker || !mother) return;
    if (!this.terminals.has(mother.id)) return;

    const tail = worker.detector.getTail(8);
    const msg = `[scuba] worker "${worker.record.name}" is idle.\nlast output:\n${tail}`;
    this.enqueueInput(mother.id, msg);
  }
}

function resolveCwd(input: string): string {
  if (!input || input.trim() === '') return os.homedir();
  const expanded = input.startsWith('~') ? input.replace(/^~/, os.homedir()) : input;
  if (!existsSync(expanded) || !statSync(expanded).isDirectory()) {
    throw new Error(`cwd is not a directory: ${expanded}`);
  }
  return expanded;
}

/**
 * Send text as input + Enter to a claude code TUI.
 *
 * Sequence:
 *   1. Write the text (bracketed paste if multi-line, plain otherwise).
 *   2. Wait ~80ms so Ink's React state can commit the character updates.
 *   3. Write \r as a separate event so the submit handler reads the freshly
 *      committed input value.
 *
 * Without the delay, Ink receives "text\r" as a single stdin chunk and triggers
 * the submit handler with a stale (empty) input value — the text shows up in
 * the input box but never submits.
 */
function writeAsPaste(proc: IPty, text: string): void {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (normalized.includes('\n')) {
    proc.write(`\x1b[200~${normalized}\x1b[201~`);
  } else {
    proc.write(normalized);
  }
  setTimeout(() => {
    try { proc.write('\r'); } catch {}
  }, 80);
}
