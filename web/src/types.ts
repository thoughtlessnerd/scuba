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

export interface TelegramStatus {
  enabled: boolean;
  bot: { username?: string; firstName?: string };
}

export type TelegramEventChatAdd = { type: 'chat:add'; chat: TelegramChat };
export type TelegramEventChatUpdate = { type: 'chat:update'; chat: TelegramChat };
export type TelegramEventChatRemove = { type: 'chat:remove'; chatId: string };
export type TelegramEventMessage = { type: 'message'; message: TelegramMessage };

export type TelegramEvent =
  | { type: 'message'; message: TelegramMessage }
  | { type: 'chat:add'; chat: TelegramChat }
  | { type: 'chat:update'; chat: TelegramChat }
  | { type: 'chat:remove'; chatId: string }
  | { type: 'hello'; enabled: boolean; bot?: { username?: string; firstName?: string } };

export const GROUP_COLORS = [
  '#7aa2f7',
  '#9ece6a',
  '#e0af68',
  '#f7768e',
  '#bb9af7',
  '#7dcfff',
  '#ff9e64',
  '#a3a3a3',
];
