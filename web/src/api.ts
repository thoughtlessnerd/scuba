import type {
  GroupInfo,
  GroupType,
  SessionInfo,
  TelegramChat,
  TelegramMediaKind,
  TelegramMessage,
  TelegramStatus,
} from './types';

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

export function telegramSocketUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/ws/telegram`;
}

export async function getTelegramStatus(): Promise<TelegramStatus> {
  const res = await fetch('/api/telegram/status');
  if (!res.ok) throw new Error(`telegram status: ${res.status}`);
  return res.json();
}

export async function listTelegramChats(): Promise<TelegramChat[]> {
  const res = await fetch('/api/telegram/chats');
  if (!res.ok) throw new Error(`telegram chats: ${res.status}`);
  return res.json();
}

export async function addTelegramChat(chatId: string, label?: string): Promise<TelegramChat> {
  const res = await fetch('/api/telegram/chats', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chatId, label }),
  });
  if (!res.ok) {
    const { error } = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(error || 'Failed to add chat');
  }
  return res.json();
}

export async function removeTelegramChat(chatId: string): Promise<void> {
  await fetch(`/api/telegram/chats/${encodeURIComponent(chatId)}`, { method: 'DELETE' });
}

export async function clearTelegramMessages(chatId: string): Promise<void> {
  await fetch(`/api/telegram/chats/${encodeURIComponent(chatId)}/messages`, { method: 'DELETE' });
}

export async function refreshTelegramChat(chatId: string): Promise<TelegramChat> {
  const res = await fetch(`/api/telegram/chats/${encodeURIComponent(chatId)}/refresh`, {
    method: 'POST',
  });
  if (!res.ok) throw new Error(`refresh: ${res.status}`);
  return res.json();
}

export async function getTelegramMessages(chatId: string): Promise<TelegramMessage[]> {
  const res = await fetch(`/api/telegram/chats/${encodeURIComponent(chatId)}/messages`);
  if (!res.ok) throw new Error(`telegram messages: ${res.status}`);
  return res.json();
}

export function telegramFileUrl(fileId: string): string {
  return `/api/telegram/files/${encodeURIComponent(fileId)}`;
}

export function kindForFile(file: File): TelegramMediaKind {
  const t = file.type;
  if (t.startsWith('image/') && t !== 'image/gif') return 'photo';
  if (t === 'image/gif') return 'animation';
  if (t.startsWith('video/')) return 'video';
  if (t.startsWith('audio/')) return 'audio';
  return 'document';
}

export async function sendTelegramMedia(
  chatId: string,
  file: File,
  kind: TelegramMediaKind,
  caption?: string,
): Promise<TelegramMessage> {
  const params = new URLSearchParams({ kind, filename: file.name });
  if (caption) params.set('caption', caption);
  const res = await fetch(
    `/api/telegram/chats/${encodeURIComponent(chatId)}/send-media?${params.toString()}`,
    {
      method: 'POST',
      headers: { 'Content-Type': file.type || 'application/octet-stream' },
      body: file,
    },
  );
  if (!res.ok) {
    const { error } = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(error || 'Failed to send media');
  }
  return res.json();
}

export async function sendTelegramMessage(chatId: string, text: string): Promise<TelegramMessage> {
  const res = await fetch(`/api/telegram/chats/${encodeURIComponent(chatId)}/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) {
    const { error } = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(error || 'Failed to send');
  }
  return res.json();
}

export interface MotherStatus {
  alive: boolean;
  configured: boolean;
  state?: 'working' | 'idle' | 'awaiting-choice' | null;
}

export async function getMotherStatus(): Promise<MotherStatus> {
  const res = await fetch('/api/agent/mother');
  if (!res.ok) throw new Error(`getMotherStatus: ${res.status}`);
  return res.json();
}

export async function spawnMother(): Promise<void> {
  const res = await fetch('/api/agent/mother', { method: 'POST' });
  if (!res.ok) {
    const { error } = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(error || 'Failed to spawn mother');
  }
}
