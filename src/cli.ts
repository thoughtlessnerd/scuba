#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import dotenv from 'dotenv';

// Load .env from cwd first, then fall back to the package root (one level above dist/).
// This way `scuba start` works both from inside the repo and from arbitrary cwds.
dotenv.config();
const here = path.dirname(fileURLToPath(import.meta.url));
const pkgEnv = path.resolve(here, '..', '.env');
if (existsSync(pkgEnv)) dotenv.config({ path: pkgEnv, override: false });

const { startServer } = await import('./server.js');

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
  scuba start [options]

Options:
  --host <host>   Bind host (default: 127.0.0.1)
  --port <port>   Bind port (default: 4242)
  --no-open       Don't auto-open the browser
  --dev           Dev mode: skip serving built frontend
  -h, --help      Show help
`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.command !== 'start') {
    printHelp();
    process.exit(args.command === 'help' ? 0 : 1);
  }

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
