import type { GroupInfo, GroupType, SessionInfo } from './types';

export async function listSessions(): Promise<SessionInfo[]> {
  const res = await fetch('/api/sessions');
  if (!res.ok) throw new Error(`listSessions: ${res.status}`);
  return res.json();
}

export async function createSession(
  cwd: string,
  groupId: string | null,
): Promise<SessionInfo> {
  const res = await fetch('/api/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cwd, groupId }),
  });
  if (!res.ok) {
    const { error } = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(error || 'Failed to create session');
  }
  return res.json();
}

export async function updateSession(
  id: string,
  patch: Partial<Pick<SessionInfo, 'name' | 'hidden' | 'groupId'>>,
): Promise<SessionInfo> {
  const res = await fetch(`/api/sessions/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`updateSession: ${res.status}`);
  return res.json();
}

export async function killSession(id: string): Promise<void> {
  await fetch(`/api/sessions/${id}`, { method: 'DELETE' });
}

export async function listGroups(): Promise<GroupInfo[]> {
  const res = await fetch('/api/groups');
  if (!res.ok) throw new Error(`listGroups: ${res.status}`);
  return res.json();
}

export async function createGroup(input: {
  name?: string;
  color?: string;
  type?: GroupType;
}): Promise<GroupInfo> {
  const res = await fetch('/api/groups', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(`createGroup: ${res.status}`);
  return res.json();
}

export async function updateGroup(
  id: string,
  patch: Partial<Pick<GroupInfo, 'name' | 'color' | 'type' | 'hidden'>>,
): Promise<GroupInfo> {
  const res = await fetch(`/api/groups/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`updateGroup: ${res.status}`);
  return res.json();
}

export async function deleteGroup(id: string): Promise<void> {
  await fetch(`/api/groups/${id}`, { method: 'DELETE' });
}

export function sessionSocketUrl(id: string): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/ws/sessions/${id}`;
}
