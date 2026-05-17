import path from 'node:path';
import os from 'node:os';
import { mkdirSync } from 'node:fs';
import Database from 'better-sqlite3';

export type AgentRole = 'mother' | 'worker' | 'adhoc';

export interface AgentTerminalRecord {
  id: string;
  claudeSessionId: string;
  cwd: string;
  name: string;
  groupId: string | null;
  chatId: string | null;
  systemPrompt: string;
  role: AgentRole;
  createdAt: number;
}

export interface AgentGroupRecord {
  id: string;
  name: string;
  color: string;
  taskDescription: string;
  createdAt: number;
}

export interface PendingPromptOption {
  num: number;
  text: string;
}

export interface PendingPromptRecord {
  id: string;
  terminalId: string;
  chatId: string;
  telegramMessageId: number;
  question: string;
  options: PendingPromptOption[];
  createdAt: number;
}

export interface AgentStoreOptions {
  dbPath?: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS terminals (
  id                  TEXT PRIMARY KEY,
  claude_session_id   TEXT NOT NULL UNIQUE,
  cwd                 TEXT NOT NULL,
  name                TEXT NOT NULL,
  group_id            TEXT,
  chat_id             TEXT,
  system_prompt       TEXT NOT NULL,
  role                TEXT NOT NULL,
  created_at          INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS groups (
  id                  TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
  color               TEXT NOT NULL,
  task_description    TEXT NOT NULL DEFAULT '',
  created_at          INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS pending_prompts (
  id                  TEXT PRIMARY KEY,
  terminal_id         TEXT NOT NULL,
  chat_id             TEXT NOT NULL,
  telegram_message_id INTEGER NOT NULL,
  question            TEXT NOT NULL,
  options_json        TEXT NOT NULL,
  created_at          INTEGER NOT NULL,
  FOREIGN KEY (terminal_id) REFERENCES terminals(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_terminals_role ON terminals(role);
CREATE INDEX IF NOT EXISTS idx_terminals_group ON terminals(group_id);
CREATE INDEX IF NOT EXISTS idx_pending_terminal ON pending_prompts(terminal_id);
`;

export class AgentStore {
  private db: Database.Database;

  constructor(opts: AgentStoreOptions = {}) {
    const dbPath = opts.dbPath ?? path.join(os.homedir(), '.scuba', 'agents.db');
    mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(SCHEMA);
    this.migrate();
  }

  /**
   * Pre-existing DBs were created with `CHECK(role IN ('mother','worker'))`.
   * Adding 'adhoc' would be rejected, so rebuild the table when we detect
   * the old constraint. Idempotent.
   *
   * SQLite recipe: temporarily disable foreign keys, build the new table,
   * copy rows, drop the old, rename. We can't ALTER TABLE RENAME first because
   * that rewrites referencing FKs in `pending_prompts` to point at the
   * renamed (then-dropped) name, leaving them dangling.
   *
   * Also self-heals a previous botched migration that left `terminals_old`
   * around or `pending_prompts` referencing it.
   */
  private migrate(): void {
    const row = this.db.prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='terminals'",
    ).get() as { sql: string } | undefined;
    const hasOld = this.db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='terminals_old'",
    ).get() as { name: string } | undefined;
    const promptsRow = this.db.prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='pending_prompts'",
    ).get() as { sql: string } | undefined;
    const promptsBroken = promptsRow?.sql.includes('terminals_old');

    const needsTerminalsRebuild = row?.sql.includes('CHECK');
    if (!needsTerminalsRebuild && !hasOld && !promptsBroken) return;

    this.db.pragma('foreign_keys = OFF');
    try {
      this.db.exec(`
        BEGIN;

        -- Restore terminals from a stray rename, if any.
        ${hasOld && !needsTerminalsRebuild ? 'DROP TABLE IF EXISTS terminals_old;' : ''}

        -- Rebuild terminals without the CHECK constraint.
        CREATE TABLE IF NOT EXISTS terminals_new (
          id                  TEXT PRIMARY KEY,
          claude_session_id   TEXT NOT NULL UNIQUE,
          cwd                 TEXT NOT NULL,
          name                TEXT NOT NULL,
          group_id            TEXT,
          chat_id             TEXT,
          system_prompt       TEXT NOT NULL,
          role                TEXT NOT NULL,
          created_at          INTEGER NOT NULL
        );
        INSERT OR IGNORE INTO terminals_new
          SELECT * FROM terminals;
        ${hasOld ? 'INSERT OR IGNORE INTO terminals_new SELECT * FROM terminals_old;' : ''}
        DROP TABLE terminals;
        ${hasOld ? 'DROP TABLE IF EXISTS terminals_old;' : ''}
        ALTER TABLE terminals_new RENAME TO terminals;

        -- Rebuild pending_prompts if its FK references a stale name.
        ${promptsBroken ? `
        CREATE TABLE pending_prompts_new (
          id                  TEXT PRIMARY KEY,
          terminal_id         TEXT NOT NULL,
          chat_id             TEXT NOT NULL,
          telegram_message_id INTEGER NOT NULL,
          question            TEXT NOT NULL,
          options_json        TEXT NOT NULL,
          created_at          INTEGER NOT NULL,
          FOREIGN KEY (terminal_id) REFERENCES terminals(id) ON DELETE CASCADE
        );
        INSERT INTO pending_prompts_new SELECT * FROM pending_prompts;
        DROP TABLE pending_prompts;
        ALTER TABLE pending_prompts_new RENAME TO pending_prompts;
        ` : ''}

        -- Cascade deletes never fired while the FK pointed at a dropped
        -- table, so manually clear orphaned prompts.
        DELETE FROM pending_prompts
          WHERE terminal_id NOT IN (SELECT id FROM terminals);

        CREATE INDEX IF NOT EXISTS idx_terminals_role ON terminals(role);
        CREATE INDEX IF NOT EXISTS idx_terminals_group ON terminals(group_id);
        CREATE INDEX IF NOT EXISTS idx_pending_terminal ON pending_prompts(terminal_id);
        COMMIT;
      `);
    } catch (err) {
      this.db.exec('ROLLBACK;');
      throw err;
    } finally {
      this.db.pragma('foreign_keys = ON');
    }
    console.log('[agent-store] schema migration completed');
  }

  close(): void {
    this.db.close();
  }

  // ---------- terminals ----------

  insertTerminal(rec: AgentTerminalRecord): void {
    this.db.prepare(
      `INSERT INTO terminals (id, claude_session_id, cwd, name, group_id, chat_id, system_prompt, role, created_at)
       VALUES (@id, @claudeSessionId, @cwd, @name, @groupId, @chatId, @systemPrompt, @role, @createdAt)`,
    ).run(rec);
  }

  updateTerminal(id: string, patch: Partial<Omit<AgentTerminalRecord, 'id' | 'createdAt'>>): void {
    const fields: string[] = [];
    const values: Record<string, unknown> = { id };
    if (patch.claudeSessionId !== undefined) { fields.push('claude_session_id = @claudeSessionId'); values.claudeSessionId = patch.claudeSessionId; }
    if (patch.cwd !== undefined) { fields.push('cwd = @cwd'); values.cwd = patch.cwd; }
    if (patch.name !== undefined) { fields.push('name = @name'); values.name = patch.name; }
    if (patch.groupId !== undefined) { fields.push('group_id = @groupId'); values.groupId = patch.groupId; }
    if (patch.chatId !== undefined) { fields.push('chat_id = @chatId'); values.chatId = patch.chatId; }
    if (patch.systemPrompt !== undefined) { fields.push('system_prompt = @systemPrompt'); values.systemPrompt = patch.systemPrompt; }
    if (patch.role !== undefined) { fields.push('role = @role'); values.role = patch.role; }
    if (fields.length === 0) return;
    this.db.prepare(`UPDATE terminals SET ${fields.join(', ')} WHERE id = @id`).run(values);
  }

  deleteTerminal(id: string): boolean {
    const res = this.db.prepare('DELETE FROM terminals WHERE id = ?').run(id);
    return res.changes > 0;
  }

  getTerminal(id: string): AgentTerminalRecord | undefined {
    const row = this.db.prepare('SELECT * FROM terminals WHERE id = ?').get(id) as TerminalRow | undefined;
    return row ? rowToTerminal(row) : undefined;
  }

  listTerminals(filter?: { role?: AgentRole; groupId?: string | null }): AgentTerminalRecord[] {
    const where: string[] = [];
    const params: Record<string, unknown> = {};
    if (filter?.role) { where.push('role = @role'); params.role = filter.role; }
    if (filter && 'groupId' in filter) {
      if (filter.groupId === null) where.push('group_id IS NULL');
      else { where.push('group_id = @groupId'); params.groupId = filter.groupId; }
    }
    const sql = `SELECT * FROM terminals${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY created_at ASC`;
    const rows = this.db.prepare(sql).all(params) as TerminalRow[];
    return rows.map(rowToTerminal);
  }

  getMother(): AgentTerminalRecord | undefined {
    const row = this.db.prepare("SELECT * FROM terminals WHERE role = 'mother' LIMIT 1").get() as TerminalRow | undefined;
    return row ? rowToTerminal(row) : undefined;
  }

  // ---------- groups ----------

  insertGroup(rec: AgentGroupRecord): void {
    this.db.prepare(
      `INSERT INTO groups (id, name, color, task_description, created_at)
       VALUES (@id, @name, @color, @taskDescription, @createdAt)`,
    ).run(rec);
  }

  updateGroup(id: string, patch: Partial<Omit<AgentGroupRecord, 'id' | 'createdAt'>>): void {
    const fields: string[] = [];
    const values: Record<string, unknown> = { id };
    if (patch.name !== undefined) { fields.push('name = @name'); values.name = patch.name; }
    if (patch.color !== undefined) { fields.push('color = @color'); values.color = patch.color; }
    if (patch.taskDescription !== undefined) { fields.push('task_description = @taskDescription'); values.taskDescription = patch.taskDescription; }
    if (fields.length === 0) return;
    this.db.prepare(`UPDATE groups SET ${fields.join(', ')} WHERE id = @id`).run(values);
  }

  deleteGroup(id: string): boolean {
    const res = this.db.prepare('DELETE FROM groups WHERE id = ?').run(id);
    return res.changes > 0;
  }

  getGroup(id: string): AgentGroupRecord | undefined {
    const row = this.db.prepare('SELECT * FROM groups WHERE id = ?').get(id) as GroupRow | undefined;
    return row ? rowToGroup(row) : undefined;
  }

  listGroups(): AgentGroupRecord[] {
    const rows = this.db.prepare('SELECT * FROM groups ORDER BY created_at ASC').all() as GroupRow[];
    return rows.map(rowToGroup);
  }

  // ---------- pending prompts ----------

  insertPendingPrompt(rec: PendingPromptRecord): void {
    this.db.prepare(
      `INSERT INTO pending_prompts (id, terminal_id, chat_id, telegram_message_id, question, options_json, created_at)
       VALUES (@id, @terminalId, @chatId, @telegramMessageId, @question, @optionsJson, @createdAt)`,
    ).run({
      ...rec,
      optionsJson: JSON.stringify(rec.options),
    });
  }

  deletePendingPrompt(id: string): boolean {
    const res = this.db.prepare('DELETE FROM pending_prompts WHERE id = ?').run(id);
    return res.changes > 0;
  }

  deletePendingPromptsForTerminal(terminalId: string): number {
    const res = this.db.prepare('DELETE FROM pending_prompts WHERE terminal_id = ?').run(terminalId);
    return res.changes;
  }

  getPendingPrompt(id: string): PendingPromptRecord | undefined {
    const row = this.db.prepare('SELECT * FROM pending_prompts WHERE id = ?').get(id) as PromptRow | undefined;
    return row ? rowToPrompt(row) : undefined;
  }

  getPendingPromptByMessage(chatId: string, telegramMessageId: number): PendingPromptRecord | undefined {
    const row = this.db.prepare(
      'SELECT * FROM pending_prompts WHERE chat_id = ? AND telegram_message_id = ?',
    ).get(chatId, telegramMessageId) as PromptRow | undefined;
    return row ? rowToPrompt(row) : undefined;
  }

  listPendingPromptsForTerminal(terminalId: string): PendingPromptRecord[] {
    const rows = this.db.prepare(
      'SELECT * FROM pending_prompts WHERE terminal_id = ? ORDER BY created_at ASC',
    ).all(terminalId) as PromptRow[];
    return rows.map(rowToPrompt);
  }
}

// ---------- row types + mappers ----------

interface TerminalRow {
  id: string;
  claude_session_id: string;
  cwd: string;
  name: string;
  group_id: string | null;
  chat_id: string | null;
  system_prompt: string;
  role: AgentRole;
  created_at: number;
}

interface GroupRow {
  id: string;
  name: string;
  color: string;
  task_description: string;
  created_at: number;
}

interface PromptRow {
  id: string;
  terminal_id: string;
  chat_id: string;
  telegram_message_id: number;
  question: string;
  options_json: string;
  created_at: number;
}

function rowToTerminal(r: TerminalRow): AgentTerminalRecord {
  return {
    id: r.id,
    claudeSessionId: r.claude_session_id,
    cwd: r.cwd,
    name: r.name,
    groupId: r.group_id,
    chatId: r.chat_id,
    systemPrompt: r.system_prompt,
    role: r.role,
    createdAt: r.created_at,
  };
}

function rowToGroup(r: GroupRow): AgentGroupRecord {
  return {
    id: r.id,
    name: r.name,
    color: r.color,
    taskDescription: r.task_description,
    createdAt: r.created_at,
  };
}

function rowToPrompt(r: PromptRow): PendingPromptRecord {
  return {
    id: r.id,
    terminalId: r.terminal_id,
    chatId: r.chat_id,
    telegramMessageId: r.telegram_message_id,
    question: r.question,
    options: JSON.parse(r.options_json) as PendingPromptOption[],
    createdAt: r.created_at,
  };
}
