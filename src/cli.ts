#!/usr/bin/env node
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import readline from 'node:readline/promises';
import dotenv from 'dotenv';

// Load .env from cwd, then ~/.scuba/.env, then the package root (one level above dist/).
// `override: false` means earlier loads win.
dotenv.config();
const userEnv = path.join(os.homedir(), '.scuba', '.env');
if (existsSync(userEnv)) dotenv.config({ path: userEnv, override: false });
const here = path.dirname(fileURLToPath(import.meta.url));
const pkgEnv = path.resolve(here, '..', '.env');
if (existsSync(pkgEnv)) dotenv.config({ path: pkgEnv, override: false });

interface CliArgs {
  command: string;
  host: string;
  port: number;
  dev: boolean;
  open: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    command: argv[0] ?? 'start',
    host: '127.0.0.1',
    port: 4242,
    dev: false,
    open: true,
  };

  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--host') args.host = argv[++i];
    else if (a === '--port') args.port = Number(argv[++i]);
    else if (a === '--dev') args.dev = true;
    else if (a === '--no-open') args.open = false;
    else if (a === '-h' || a === '--help') {
      printHelp();
      process.exit(0);
    }
  }
  return args;
}

function printHelp() {
  console.log(`scuba — spawn terminals in any folder from your browser

Usage:
  scuba setup            Interactive: write ~/.scuba/.env with required tokens
  scuba start [options]  Boot the server

Options (start):
  --host <host>   Bind host (default: 127.0.0.1)
  --port <port>   Bind port (default: 4242)
  --no-open       Don't auto-open the browser
  --dev           Dev mode: skip serving built frontend
  -h, --help      Show help
`);
}

function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/i);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[m[1]] = v;
  }
  return out;
}

function serializeEnv(vars: Record<string, string>): string {
  const order = ['TELEGRAM_BOT_TOKEN', 'MOTHER_TELEGRAM_CHAT_ID', 'MOTHER_CWD', 'TURN_END_DEBOUNCE_MS'];
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const k of order) {
    if (k in vars) {
      lines.push(`${k}=${vars[k]}`);
      seen.add(k);
    }
  }
  for (const [k, v] of Object.entries(vars)) {
    if (seen.has(k)) continue;
    lines.push(`${k}=${v}`);
  }
  return lines.join('\n') + '\n';
}

async function runSetup() {
  const dir = path.join(os.homedir(), '.scuba');
  const file = path.join(dir, '.env');
  mkdirSync(dir, { recursive: true });

  const existing: Record<string, string> = existsSync(file) ? parseEnvFile(readFileSync(file, 'utf8')) : {};

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  async function ask(key: string, label: string, opts: { required: boolean; help?: string }): Promise<string> {
    const current = existing[key] ?? process.env[key] ?? '';
    const hint = current ? ` [current: ${key === 'TELEGRAM_BOT_TOKEN' ? mask(current) : current}]` : '';
    if (opts.help) console.log(`  ${opts.help}`);
    while (true) {
      const answer = (await rl.question(`${label}${hint}: `)).trim();
      const value = answer || current;
      if (!value && opts.required) {
        console.log(`  ${key} is required.`);
        continue;
      }
      return value;
    }
  }

  console.log('scuba setup — writes ~/.scuba/.env\n');
  const token = await ask('TELEGRAM_BOT_TOKEN', 'Telegram bot token', {
    required: true,
    help: 'Get one from @BotFather on Telegram.',
  });
  const motherChat = await ask('MOTHER_TELEGRAM_CHAT_ID', 'Mother Telegram chat id', {
    required: true,
    help: 'The chat id (usually your DM with the bot) that mother listens to.',
  });
  const motherCwd = await ask('MOTHER_CWD', 'Mother cwd (optional, blank = ~/.scuba/mother-home)', {
    required: false,
  });
  const debounce = await ask('TURN_END_DEBOUNCE_MS', 'Turn-end debounce ms (optional, blank = 1500)', {
    required: false,
  });
  rl.close();

  const next: Record<string, string> = { ...existing };
  next.TELEGRAM_BOT_TOKEN = token;
  next.MOTHER_TELEGRAM_CHAT_ID = motherChat;
  if (motherCwd) next.MOTHER_CWD = motherCwd; else delete next.MOTHER_CWD;
  if (debounce) next.TURN_END_DEBOUNCE_MS = debounce; else delete next.TURN_END_DEBOUNCE_MS;

  writeFileSync(file, serializeEnv(next), { mode: 0o600 });
  console.log(`\nWrote ${file}`);
  console.log('Run `scuba start` to boot.');
}

function mask(s: string): string {
  if (s.length <= 8) return '***';
  return s.slice(0, 4) + '…' + s.slice(-4);
}

function requireEnv() {
  const missing: string[] = [];
  if (!process.env.TELEGRAM_BOT_TOKEN?.trim()) missing.push('TELEGRAM_BOT_TOKEN');
  if (!process.env.MOTHER_TELEGRAM_CHAT_ID?.trim()) missing.push('MOTHER_TELEGRAM_CHAT_ID');
  if (missing.length) {
    console.error(`Missing required env: ${missing.join(', ')}`);
    console.error('Run `scuba setup` to configure.');
    process.exit(1);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.command === 'setup') {
    await runSetup();
    return;
  }

  if (args.command !== 'start') {
    printHelp();
    process.exit(args.command === 'help' ? 0 : 1);
  }

  requireEnv();

  const { startServer } = await import('./server.js');
  await startServer({ host: args.host, port: args.port, dev: args.dev });
  const apiUrl = `http://${args.host}:${args.port}`;
  if (args.dev) {
    console.log(`scuba (dev) — API at ${apiUrl}, UI at http://localhost:5173`);
  } else {
    console.log(`scuba running at ${apiUrl}`);
    if (args.open) openBrowser(apiUrl);
  }
}

async function openBrowser(url: string) {
  const { exec } = await import('node:child_process');
  const cmd =
    process.platform === 'darwin' ? `open "${url}"`
    : process.platform === 'win32' ? `start "" "${url}"`
    : `xdg-open "${url}"`;
  exec(cmd, () => {});
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
