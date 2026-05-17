export type GroupType = 'tabs' | 'tiled';

export interface SessionInfo {
  id: string;
  cwd: string;
  shell: string;
  createdAt: number;
  name?: string;
  hidden: boolean;
  groupId: string | null;
}

export interface GroupInfo {
  id: string;
  name: string;
  color: string;
  type: GroupType;
  hidden: boolean;
  order: number;
}

export interface CreateSessionRequest {
  cwd?: string;
  shell?: string;
  cols?: number;
  rows?: number;
  groupId?: string | null;
}

export interface UpdateSessionRequest {
  name?: string;
  hidden?: boolean;
  groupId?: string | null;
}

export interface CreateGroupRequest {
  name?: string;
  color?: string;
  type?: GroupType;
}

export interface UpdateGroupRequest {
  name?: string;
  color?: string;
  type?: GroupType;
  hidden?: boolean;
}

export type ClientMessage =
  | { type: 'input'; data: string }
  | { type: 'resize'; cols: number; rows: number };

export type ServerMessage =
  | { type: 'output'; data: string }
  | { type: 'exit'; code: number; signal?: number };

export interface TelegramChat {
  chatId: string;
  label?: string;
  title?: string;
  addedAt: number;
  photoFileId?: string;
  type?: 'private' | 'group' | 'supergroup' | 'channel';
}

export type TelegramMediaKind =
  | 'photo'
  | 'video'
  | 'audio'
  | 'voice'
  | 'document'
  | 'sticker'
  | 'animation'
  | 'video_note';

export interface TelegramMedia {
  kind: TelegramMediaKind;
  fileId: string;
  mimeType?: string;
  fileName?: string;
  width?: number;
  height?: number;
  duration?: number;
  size?: number;
  thumbFileId?: string;
}

export interface TelegramMessage {
  id: number;
  chatId: string;
  from: 'user' | 'bot';
  text: string;
  date: number;
  senderName?: string;
  media?: TelegramMedia;
}

export type TelegramServerEvent =
  | { type: 'message'; message: TelegramMessage }
  | { type: 'chat:add'; chat: TelegramChat }
  | { type: 'chat:update'; chat: TelegramChat }
  | { type: 'chat:remove'; chatId: string }
  | { type: 'hello'; enabled: boolean; bot?: { username?: string; firstName?: string } };
