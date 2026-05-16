import type { SessionInfo } from './types';

export function shortCwd(cwd: string): string {
  const parts = cwd.split('/').filter(Boolean);
  if (parts.length <= 2) return cwd;
  return '…/' + parts.slice(-2).join('/');
}

export function sessionLabel(s: SessionInfo): string {
  return s.name && s.name.trim() !== '' ? s.name : shortCwd(s.cwd);
}
