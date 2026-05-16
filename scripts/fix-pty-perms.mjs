import { chmodSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);

try {
  const ptyPkg = require.resolve('node-pty/package.json');
  const root = path.dirname(ptyPkg);
  for (const arch of ['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64']) {
    const helper = path.join(root, 'prebuilds', arch, 'spawn-helper');
    if (existsSync(helper)) chmodSync(helper, 0o755);
  }
} catch {}
