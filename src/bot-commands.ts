import type { AgentManager, AgentTerminal } from './agent-manager.js';
import type { TelegramManager } from './telegram.js';
import { renderScreenPng } from './screenshot.js';

export interface BotCommandContext {
  agents: AgentManager;
  telegram: TelegramManager;
  chatId: string;
  /** The terminal bound to this chat. Mother's chat → mother. Adhoc-bound chat → that adhoc. */
  terminal: AgentTerminal;
  /** The slash command's args after the command itself (split on whitespace). */
  args: string[];
  /** Raw text after the command name (trimmed), useful for confirmation guards. */
  argLine: string;
}

export interface BotCommand {
  name: string;
  description: string;
  /** If true, only runs when the bound terminal is mother. */
  motherOnly?: boolean;
  handler: (ctx: BotCommandContext) => Promise<void>;
}

const COMMANDS: BotCommand[] = [
  {
    name: 'help',
    description: 'List available commands.',
    handler: async ({ telegram, chatId, terminal }) => {
      const lines = ['Available commands:'];
      for (const cmd of COMMANDS) {
        if (cmd.motherOnly && terminal.record.role !== 'mother') continue;
        lines.push(`/${cmd.name} — ${cmd.description}`);
      }
      await telegram.sendMessage(chatId, lines.join('\n'));
    },
  },
  {
    name: 'status',
    description: 'Show this terminal’s state, name, role, cwd, and queue depth.',
    handler: async ({ telegram, chatId, terminal }) => {
      const state = terminal.detector.getState();
      const msg = [
        `name: ${terminal.record.name}`,
        `role: ${terminal.record.role}`,
        `state: ${state}`,
        `cwd: ${terminal.record.cwd}`,
        `queue: ${terminal.queue.length}`,
      ].join('\n');
      await telegram.sendMessage(chatId, msg);
    },
  },
  {
    name: 'cwd',
    description: 'Print the cwd of this terminal.',
    handler: async ({ telegram, chatId, terminal }) => {
      await telegram.sendMessage(chatId, terminal.record.cwd);
    },
  },
  {
    name: 'screenshot',
    description: 'Send a PNG of the terminal’s current screen.',
    handler: async ({ telegram, chatId, terminal }) => {
      const screen = terminal.detector.getColoredScreen();
      const png = await renderScreenPng(screen);
      await telegram.sendMedia(
        chatId,
        'photo',
        png,
        `${terminal.record.name}.png`,
        'image/png',
        `${terminal.record.name} (${terminal.detector.getState()})`,
      );
    },
  },
  {
    name: 'tail',
    description: 'Last N lines of terminal output as text. Default 20, max 100.',
    handler: async ({ telegram, chatId, terminal, args }) => {
      const requested = Number(args[0]);
      const n = Number.isFinite(requested) && requested > 0 ? Math.min(100, Math.floor(requested)) : 20;
      const tail = terminal.detector.getTail(n).trimEnd();
      const body = tail.length === 0 ? '(empty)' : tail;
      // Wrap in a code block so Telegram preserves spacing.
      const max = 3500;
      const truncated = body.length > max ? body.slice(-max) : body;
      const escaped = truncated.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      await telegram.sendMessage(chatId, `<pre>${escaped}</pre>`, { parseMode: 'HTML' })
        .catch(async () => {
          await telegram.sendMessage(chatId, truncated);
        });
    },
  },
  {
    name: 'clear',
    description: 'Clear the conversation context of this terminal (sends claude’s /clear).',
    handler: async ({ telegram, chatId, agents, terminal }) => {
      const ok = agents.typeInto(terminal.record.id, '/clear\r');
      await telegram.sendMessage(chatId, ok ? 'context cleared.' : 'terminal not alive.');
    },
  },
  {
    name: 'compact',
    description: 'Compress this terminal’s context without losing it (sends claude’s /compact).',
    handler: async ({ telegram, chatId, agents, terminal }) => {
      const ok = agents.typeInto(terminal.record.id, '/compact\r');
      await telegram.sendMessage(chatId, ok ? 'compacting context…' : 'terminal not alive.');
    },
  },
  {
    name: 'cancel',
    description: 'Interrupt the current turn and clear the input bar.',
    handler: async ({ telegram, chatId, agents, terminal }) => {
      // Esc interrupts claude's in-progress turn. Ctrl+U (\x15) clears the
      // input line in Ink's TextInput — without this, whatever text was sitting
      // in the input bar before the interrupt stays there with no way to drop
      // it from Telegram.
      const id = terminal.record.id;
      const ok = agents.typeInto(id, '\x1b');
      if (ok) setTimeout(() => { agents.typeInto(id, '\x15'); }, 80);
      await telegram.sendMessage(chatId, ok ? 'sent Esc + cleared input.' : 'terminal not alive.');
    },
  },
  {
    name: 'restart',
    description: 'Kill this terminal’s PTY and respawn it via --resume (preserves context).',
    handler: async ({ telegram, chatId, agents, terminal }) => {
      const ok = agents.restartTerminal(terminal.record.id);
      await telegram.sendMessage(chatId, ok ? 'restarted.' : 'restart failed (see server logs).');
    },
  },
  {
    name: 'kill',
    description: 'Destroy this terminal and its record. Requires `/kill confirm` to actually destroy.',
    handler: async ({ telegram, chatId, agents, terminal, argLine }) => {
      if (argLine.trim() !== 'confirm') {
        await telegram.sendMessage(
          chatId,
          `this will kill "${terminal.record.name}" and delete its record. send \`/kill confirm\` to proceed.`,
        );
        return;
      }
      const name = terminal.record.name;
      const ok = agents.killTerminal(terminal.record.id);
      await telegram.sendMessage(chatId, ok ? `killed ${name}.` : 'kill failed.');
    },
  },
];

const COMMAND_MAP = new Map(COMMANDS.map((c) => [c.name, c]));

/** Shape expected by Telegram's setMyCommands. */
export function telegramCommandManifest(): { command: string; description: string }[] {
  return COMMANDS.map((c) => ({
    command: c.name,
    // Telegram caps description at 256 chars; ours are well within.
    description: c.description,
  }));
}

/**
 * "Ready" greeting posted to a terminal's bound chat when it spawns (or
 * respawns at scuba boot, or after /restart). Lists the commands available
 * in that chat so the human knows what's at their fingertips.
 */
export function buildReadyMessage(terminal: AgentTerminal): string {
  const lines: string[] = [];
  const label = terminal.record.role === 'mother' ? 'mother' : terminal.record.name;
  lines.push(`${label} is ready. (${terminal.record.role}, cwd: ${terminal.record.cwd})`);
  lines.push('');
  lines.push('Commands:');
  for (const cmd of COMMANDS) {
    if (cmd.motherOnly && terminal.record.role !== 'mother') continue;
    lines.push(`/${cmd.name} — ${cmd.description}`);
  }
  return lines.join('\n');
}

export interface ResolveOptions {
  agents: AgentManager;
  chatId: string;
  motherChatId: string | null;
}

/**
 * Resolve which terminal a slash command in `chatId` should act on.
 * Mother chat → mother terminal. Adhoc-bound chat → first adhoc bound to it
 * (logs if multiple). Returns null if no live terminal is bound.
 */
export function resolveBoundTerminal(opts: ResolveOptions): AgentTerminal | null {
  if (opts.motherChatId && opts.chatId === opts.motherChatId) {
    const mother = opts.agents.listTerminals().find((t) => t.record.role === 'mother');
    return mother ?? null;
  }
  const adhocs = opts.agents
    .listTerminals()
    .filter((t) => t.record.role === 'adhoc' && t.record.chatId === opts.chatId);
  if (adhocs.length === 0) return null;
  if (adhocs.length > 1) {
    console.warn(
      `[bot-cmd] chat ${opts.chatId} bound to ${adhocs.length} adhoc terminals — using first (${adhocs[0].record.name})`,
    );
  }
  return adhocs[0];
}

export interface ParsedCommand {
  name: string;
  args: string[];
  argLine: string;
}

export function parseCommand(text: string): ParsedCommand | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return null;
  const space = trimmed.indexOf(' ');
  let name = (space === -1 ? trimmed.slice(1) : trimmed.slice(1, space)).toLowerCase();
  // Telegram appends `@botusername` to commands in groups (and sometimes DMs).
  // Strip it so /screenshot@my_bot resolves the same as /screenshot.
  const at = name.indexOf('@');
  if (at !== -1) name = name.slice(0, at);
  if (!name) return null;
  const argLine = space === -1 ? '' : trimmed.slice(space + 1).trim();
  const args = argLine.length === 0 ? [] : argLine.split(/\s+/);
  return { name, args, argLine };
}

export function getCommand(name: string): BotCommand | undefined {
  return COMMAND_MAP.get(name);
}

/**
 * Top-level dispatch. Returns true if the text was a known command (handled
 * or rejected with a message), false if it should fall through to normal
 * input routing.
 */
export async function dispatchCommand(
  text: string,
  chatId: string,
  motherChatId: string | null,
  agents: AgentManager,
  telegram: TelegramManager,
): Promise<boolean> {
  const parsed = parseCommand(text);
  if (!parsed) return false;
  const cmd = getCommand(parsed.name);
  if (!cmd) return false;

  const terminal = resolveBoundTerminal({ agents, chatId, motherChatId });
  if (!terminal) {
    await telegram.sendMessage(chatId, `no live terminal bound to this chat — \`/${parsed.name}\` ignored.`);
    return true;
  }
  if (cmd.motherOnly && terminal.record.role !== 'mother') {
    await telegram.sendMessage(chatId, `\`/${parsed.name}\` is mother-only.`);
    return true;
  }

  try {
    await cmd.handler({
      agents,
      telegram,
      chatId,
      terminal,
      args: parsed.args,
      argLine: parsed.argLine,
    });
  } catch (err) {
    console.error(`[bot-cmd] /${parsed.name} failed:`, err);
    await telegram.sendMessage(chatId, `\`/${parsed.name}\` failed: ${(err as Error).message}`).catch(() => {});
  }
  return true;
}
