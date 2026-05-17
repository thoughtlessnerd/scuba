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
/**
 * How long the terminal must stay in ready/idle after a turn before we count
 * it as actually finished. Claude's TUI briefly flips back to the prompt
 * between tool calls / message segments — firing turn-end on the first blink
 * sends premature "replied" screenshots. Override via TURN_END_DEBOUNCE_MS env.
 */
const TURN_END_DEBOUNCE_MS = (() => {
  const raw = Number(process.env.TURN_END_DEBOUNCE_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 1500;
})();

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

export interface SpawnAdhocOptions {
  cwd: string;
  chatId: string;
  name?: string;
  systemPrompt?: string;
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
  /** Debounced turn-end emit. Cancelled if the terminal flips back to working. */
  turnEndTimer: NodeJS.Timeout | null;
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
      if (t.turnEndTimer) { clearTimeout(t.turnEndTimer); t.turnEndTimer = null; }
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

  /**
   * Spawn an isolated adhoc claude terminal. Unlike mother/worker, adhoc has:
   * no MCP server (just runs in user's cwd), no group, no role-coupling
   * (cannot spawn other terminals, cannot be sent to by mother). Routing to
   * Telegram for awaiting-choice prompts works via record.chatId — the same
   * PromptRouter path workers use.
   */
  spawnAdhoc(opts: SpawnAdhocOptions): AgentTerminal {
    const cwd = resolveCwd(opts.cwd);
    const claudeSessionId = randomUUID();
    const id = randomUUID();
    const name = (opts.name?.trim() || 'claude').slice(0, 15);
    const systemPrompt = opts.systemPrompt ?? '';
    const args = [
      '--session-id', claudeSessionId,
      '--permission-mode', 'acceptEdits',
      '-n', name,
    ];
    if (systemPrompt) args.push('--system-prompt', systemPrompt);
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
      systemPrompt,
      role: 'adhoc',
      createdAt: Date.now(),
    };
    this.store.insertTerminal(record);
    return this.registerSpawn(proc, record);
  }

  spawnMother(opts: SpawnMotherOptions): AgentTerminal {
    const existing = this.store.getMother();
    if (existing) {
      // Whether the PTY is live or stale, the user clicking "Spawn mother"
      // means they want a fresh mother. Kill any live PTY first, then drop
      // the row so the spawn below isn't blocked by it.
      const live = this.terminals.get(existing.id);
      if (live) {
        try { live.pty.kill(); } catch {}
        try { live.detector.destroy(); } catch {}
        this.terminals.delete(existing.id);
      }
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
    ];
    if (rec.systemPrompt) args.push('--system-prompt', rec.systemPrompt);
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
    // Even if the PTY already died (and we removed it from the in-memory map),
    // the DB row may still be there. Clean both regardless.
    const rec = t?.record ?? this.store.getTerminal(id);
    if (!rec) return false;
    const groupId = rec.groupId;
    if (t) {
      try { t.pty.kill(); } catch {}
      try { t.detector.destroy(); } catch {}
      this.terminals.delete(id);
    }
    this.store.deleteTerminal(id);
    console.log(`[agent] killTerminal ${rec.name} (${rec.role}) — db row removed`);

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

  /**
   * Used by the Telegram bridge: when a user message arrives in a chat that has
   * adhoc terminals bound to it, enqueue the text on each. Returns the number
   * of terminals it reached.
   */
  enqueueForAdhocChat(chatId: string, text: string): number {
    let hits = 0;
    const adhocs = Array.from(this.terminals.values()).filter((t) => t.record.role === 'adhoc');
    for (const t of adhocs) {
      if (t.record.chatId !== chatId) continue;
      if (t.detector.getState() === 'awaiting-choice') {
        console.warn(
          `[agent] adhoc ${t.record.name} got TG text but is awaiting choice — dropped. Use the inline buttons to answer first.`,
        );
        continue;
      }
      this.enqueueInput(t.record.id, text);
      hits++;
      console.log(`[agent] enqueued TG text → adhoc ${t.record.name} (chat ${chatId})`);
    }
    if (hits === 0 && adhocs.length > 0) {
      console.log(
        `[agent] TG msg on chat ${chatId} matched no adhoc terminal (have ${adhocs.length}: ${adhocs.map((t) => `${t.record.name}=${t.record.chatId}`).join(', ')})`,
      );
    }
    return hits;
  }

  /** Used by Telegram bridge for mother chat. Queue + drain when idle. */
  enqueueForMother(text: string): boolean {
    const mother = this.store.getMother();
    if (!mother) return false;
    if (!this.terminals.has(mother.id)) return false;
    this.enqueueInput(mother.id, text);
    return true;
  }

  /**
   * Used by Telegram bridge for inline-keyboard callback. Writes the digit, then
   * Enter ~80ms later as a separate chunk. Sending them together causes Ink's
   * stdin handler to read the (still stale) input on the Enter event and ignore
   * the choice — the same race that writeAsPaste works around for queued input.
   */
  answerAwaitingChoice(id: string, choice: number): boolean {
    const t = this.terminals.get(id);
    if (!t) {
      console.warn(`[agent] answerAwaitingChoice: terminal ${id} not live`);
      return false;
    }
    if (t.detector.getState() !== 'awaiting-choice') {
      console.warn(
        `[agent] answerAwaitingChoice: ${t.record.name} state=${t.detector.getState()} (not awaiting)`,
      );
      return false;
    }
    t.pty.write(`${choice}`);
    setTimeout(() => {
      try { t.pty.write('\r'); } catch {}
    }, 80);
    console.log(`[agent] answerAwaitingChoice: ${t.record.name} chose ${choice}`);
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
      turnEndTimer: null,
    };
    this.terminals.set(rec.id, term);

    proc.onData((data) => {
      detector.push(data);
    });
    proc.onExit(({ exitCode, signal }) => {
      console.log(
        `[agent] terminal "${rec.name}" (${rec.role}) exited code=${exitCode} signal=${signal ?? '-'}`,
      );
      if (term.turnEndTimer) { clearTimeout(term.turnEndTimer); term.turnEndTimer = null; }
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
        // Mother and adhoc mirror their replies to the bound chat. Schedule
        // the emit a beat later, since claude's TUI briefly flips to ready
        // between tool calls — without the debounce we fire on every blink.
        if (evt.from === 'working' && term.hadInputSinceTurnEnd) {
          if (rec.role === 'mother' || rec.role === 'adhoc') {
            if (term.turnEndTimer) clearTimeout(term.turnEndTimer);
            term.turnEndTimer = setTimeout(() => {
              term.turnEndTimer = null;
              if (!term.hadInputSinceTurnEnd) return;
              const state = term.detector.getState();
              if (state !== 'ready' && state !== 'idle') return;
              term.hadInputSinceTurnEnd = false;
              this.emit('turnEnd', rec.id);
            }, TURN_END_DEBOUNCE_MS);
          } else {
            // Workers don't post directly, so we can clear immediately.
            term.hadInputSinceTurnEnd = false;
          }
        }
      } else {
        // Moved off ready/idle (back to working or into awaiting-choice).
        // Cancel any pending turn-end emit.
        if (term.turnEndTimer) {
          clearTimeout(term.turnEndTimer);
          term.turnEndTimer = null;
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
