import path from 'node:path';
import os from 'node:os';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Resolve mother's working directory (creating it if missing) and write a
 * `.mcp.json` inside it that registers the scuba MCP server. Claude Code
 * auto-discovers `.mcp.json` in its cwd and exposes the listed servers'
 * tools to the session.
 *
 * Mother's tools live ONLY here — workers spawn in different cwds and won't
 * see this config, so workers can't recursively spawn workers.
 */
export function prepareMotherCwd(explicitCwd: string | undefined, scubaPort: number): string {
  const defaultDir = path.join(os.homedir(), '.scuba', 'mother-home');
  let dir = (explicitCwd ?? '').trim();
  // Expand `~` and `$HOME` shortcuts.
  if (dir === '~' || dir.startsWith('~/')) dir = path.join(os.homedir(), dir.slice(1));
  if (dir === '$HOME' || dir.startsWith('$HOME/')) dir = path.join(os.homedir(), dir.slice(5));

  // Refuse $HOME itself — writing .mcp.json there would affect every claude
  // session on this machine. Fall back to the dedicated mother dir.
  if (!dir || dir === os.homedir()) {
    if (explicitCwd && explicitCwd.trim()) {
      console.warn(
        `[agent] MOTHER_CWD resolves to $HOME; refusing to write .mcp.json there. Using ${defaultDir} instead.`,
      );
    }
    dir = defaultDir;
  }

  mkdirSync(dir, { recursive: true });
  writeMcpConfig(dir, scubaPort);
  return dir;
}

function writeMcpConfig(dir: string, port: number): void {
  // here = directory containing the running module. In production builds that's
  // `<root>/dist`; under tsx/dev it's `<root>/src`. The mcp-server file sits
  // alongside us in either case.
  const distMcp = path.resolve(here, 'mcp-server.js');
  const srcMcp = path.resolve(here, 'mcp-server.ts');

  let command: string;
  let args: string[];
  if (existsSync(distMcp)) {
    command = 'node';
    args = [distMcp];
  } else if (existsSync(srcMcp)) {
    command = 'npx';
    args = ['tsx', srcMcp];
  } else {
    throw new Error(`mcp-server file not found near ${here}`);
  }

  const config = {
    mcpServers: {
      scuba: {
        command,
        args,
        env: { SCUBA_URL: process.env.SCUBA_URL || `http://127.0.0.1:${port}` },
      },
    },
  };

  writeFileSync(path.join(dir, '.mcp.json'), JSON.stringify(config, null, 2));
}
