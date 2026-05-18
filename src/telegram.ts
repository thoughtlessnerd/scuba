import { EventEmitter } from 'node:events';
import type { Readable } from 'node:stream';
import { TelegramStore, RETENTION_DAYS } from './telegram-store.js';

export interface TelegramChat {
  chatId: string;
  label?: string;
  title?: string;
  addedAt: number;
  photoFileId?: string;
  type?: 'private' | 'group' | 'supergroup' | 'channel';
}

export type MediaKind =
  | 'photo'
  | 'video'
  | 'audio'
  | 'voice'
  | 'document'
  | 'sticker'
  | 'animation'
  | 'video_note';

export interface TelegramMedia {
  kind: MediaKind;
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

export interface InlineKeyboardButton {
  text: string;
  callback_data?: string;
  url?: string;
}

export interface InlineKeyboardMarkup {
  inline_keyboard: InlineKeyboardButton[][];
}

export interface TelegramCallback {
  id: string;
  chatId: string;
  messageId: number;
  data: string;
  from?: { id: string; name?: string };
}

const RETENTION_SECONDS = RETENTION_DAYS * 24 * 60 * 60;
const COMPACT_INTERVAL_MS = 6 * 60 * 60 * 1000;

const SEND_METHOD_BY_KIND: Record<MediaKind, { method: string; field: string } | undefined> = {
  photo: { method: 'sendPhoto', field: 'photo' },
  video: { method: 'sendVideo', field: 'video' },
  audio: { method: 'sendAudio', field: 'audio' },
  voice: { method: 'sendVoice', field: 'voice' },
  document: { method: 'sendDocument', field: 'document' },
  animation: { method: 'sendAnimation', field: 'animation' },
  sticker: undefined,
  video_note: undefined,
};

export class TelegramManager extends EventEmitter {
  private token: string | null;
  private chats = new Map<string, TelegramChat>();
  private messages = new Map<string, TelegramMessage[]>();
  private offset = 0;
  private polling = false;
  private botUsername?: string;
  private botFirstName?: string;
  private store: TelegramStore;
  private compactTimer?: NodeJS.Timeout;

  constructor(token: string | undefined, store?: TelegramStore) {
    super();
    this.token = token && token.trim() ? token.trim() : null;
    this.store = store ?? new TelegramStore();
  }

  get enabled() {
    return this.token !== null;
  }

  get botInfo() {
    return { username: this.botUsername, firstName: this.botFirstName };
  }

  async start() {
    await this.store.init();
    const savedChats = await this.store.loadChats();
    for (const c of savedChats) {
      this.chats.set(c.chatId, c);
      const msgs = await this.store.loadMessages(c.chatId);
      this.messages.set(c.chatId, msgs);
    }
    if (savedChats.length > 0) {
      console.log(`[telegram] restored ${savedChats.length} chat(s) from ${this.store.dir}`);
    }

    void this.store.compactAll();
    this.compactTimer = setInterval(() => void this.store.compactAll(), COMPACT_INTERVAL_MS);
    if (this.compactTimer.unref) this.compactTimer.unref();

    if (!this.token) {
      console.log('[telegram] disabled — TELEGRAM_BOT_TOKEN not set');
      return;
    }
    try {
      const me = await this.api('getMe', {});
      this.botUsername = me.username;
      this.botFirstName = me.first_name;
      console.log(`[telegram] connected as @${this.botUsername}`);
    } catch (e) {
      console.error('[telegram] getMe failed:', (e as Error).message);
      return;
    }
    for (const c of this.chats.values()) {
      if (!c.photoFileId || !c.title) void this.refreshChatMeta(c.chatId);
    }

    this.polling = true;
    void this.poll();
  }

  stop() {
    this.polling = false;
    if (this.compactTimer) clearInterval(this.compactTimer);
  }

  listChats(): TelegramChat[] {
    return [...this.chats.values()].sort((a, b) => a.addedAt - b.addedAt);
  }

  addChat(chatId: string, label?: string): TelegramChat {
    const id = String(chatId).trim();
    if (!id) throw new Error('chatId required');
    const existing = this.chats.get(id);
    if (existing) {
      if (label !== undefined) existing.label = label;
      this.emit('chat:update', existing);
      void this.persistChats();
      return existing;
    }
    const chat: TelegramChat = { chatId: id, label, addedAt: Date.now() };
    this.chats.set(id, chat);
    if (!this.messages.has(id)) this.messages.set(id, []);
    this.emit('chat:add', chat);
    void this.persistChats();
    void this.refreshChatMeta(id);
    return chat;
  }

  async addChatVerified(chatId: string, label?: string): Promise<TelegramChat> {
    const id = String(chatId).trim();
    if (!id) throw new Error('chatId required');
    if (!this.token) throw new Error('telegram not configured');
    let info: any;
    try {
      info = await this.api('getChat', { chat_id: id });
    } catch (e) {
      const msg = (e as Error).message || '';
      if (/chat not found/i.test(msg)) throw new Error('Chat not found. Make sure the bot has been added to the chat (or you have messaged the bot from this chat at least once).');
      if (/invalid/i.test(msg) || /CHAT_ID_INVALID/i.test(msg)) throw new Error('Invalid chat ID.');
      throw new Error(msg || 'Could not verify chat');
    }
    const chat = this.addChat(id, label);
    const title =
      info.title ||
      [info.first_name, info.last_name].filter(Boolean).join(' ') ||
      info.username ||
      undefined;
    let changed = false;
    if (title && chat.title !== title) { chat.title = title; changed = true; }
    if (info.type && chat.type !== info.type) { chat.type = info.type; changed = true; }
    const photoId: string | undefined = info.photo?.small_file_id;
    if (photoId && chat.photoFileId !== photoId) { chat.photoFileId = photoId; changed = true; }
    if (changed) {
      this.emit('chat:update', chat);
      void this.persistChats();
    }
    return chat;
  }

  clearMessages(chatId: string): boolean {
    if (!this.chats.has(chatId)) return false;
    this.messages.set(chatId, []);
    void this.store.deleteChat(chatId);
    return true;
  }

  async refreshChatMeta(chatId: string): Promise<TelegramChat | null> {
    const chat = this.chats.get(chatId);
    if (!chat || !this.token) return chat ?? null;
    try {
      const info = await this.api('getChat', { chat_id: chatId });
      let changed = false;
      const title =
        info.title ||
        [info.first_name, info.last_name].filter(Boolean).join(' ') ||
        info.username ||
        undefined;
      if (title && chat.title !== title) { chat.title = title; changed = true; }
      if (info.type && chat.type !== info.type) { chat.type = info.type; changed = true; }
      const photoId: string | undefined = info.photo?.small_file_id;
      if (photoId && chat.photoFileId !== photoId) { chat.photoFileId = photoId; changed = true; }
      if (!info.photo && chat.photoFileId) { chat.photoFileId = undefined; changed = true; }
      if (changed) {
        this.emit('chat:update', chat);
        void this.persistChats();
      }
      return chat;
    } catch (e) {
      console.error(`[telegram] refreshChatMeta(${chatId}) failed:`, (e as Error).message);
      return chat;
    }
  }

  removeChat(chatId: string): boolean {
    const ok = this.chats.delete(chatId);
    this.messages.delete(chatId);
    if (ok) {
      this.emit('chat:remove', { chatId });
      void this.persistChats();
      void this.store.deleteChat(chatId);
    }
    return ok;
  }

  private persistChats(): Promise<void> {
    return this.store.saveChats([...this.chats.values()]);
  }

  getMessages(chatId: string): TelegramMessage[] {
    return this.messages.get(chatId) ?? [];
  }

  async sendMessage(
    chatId: string,
    text: string,
    opts: { parseMode?: 'Markdown' | 'MarkdownV2' | 'HTML'; replyMarkup?: InlineKeyboardMarkup } = {},
  ): Promise<TelegramMessage> {
    if (!this.token) throw new Error('telegram not configured');
    if (!this.chats.has(chatId)) {
      // Auto-register chats we send to. Useful for sending into a known-good chat that
      // the bot hasn't received a message from yet but was configured externally.
      this.addChat(chatId);
    }
    const body: Record<string, unknown> = { chat_id: chatId, text };
    if (opts.parseMode) body.parse_mode = opts.parseMode;
    if (opts.replyMarkup) body.reply_markup = opts.replyMarkup;
    const result = await this.api('sendMessage', body);
    const msg: TelegramMessage = {
      id: result.message_id,
      chatId,
      from: 'bot',
      text,
      date: result.date ?? Math.floor(Date.now() / 1000),
      senderName: this.botUsername ?? this.botFirstName ?? 'bot',
    };
    this.recordMessage(msg);
    return msg;
  }

  async editMessageReplyMarkup(
    chatId: string,
    messageId: number,
    replyMarkup: InlineKeyboardMarkup | null,
  ): Promise<void> {
    if (!this.token) throw new Error('telegram not configured');
    await this.api('editMessageReplyMarkup', {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: replyMarkup ?? { inline_keyboard: [] },
    });
  }

  /**
   * Register the bot's command menu. Telegram clients use this to populate
   * autocomplete + the "/" menu. In private chats, tapping a registered
   * command sends the bare `/cmd` (no `@botname` suffix); in groups the
   * suffix is always appended for disambiguation.
   */
  async setMyCommands(commands: { command: string; description: string }[]): Promise<void> {
    if (!this.token) return;
    try {
      await this.api('setMyCommands', { commands });
      console.log(`[telegram] registered ${commands.length} bot commands`);
    } catch (e) {
      console.warn('[telegram] setMyCommands failed:', (e as Error).message);
    }
  }

  async answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
    if (!this.token) return;
    try {
      await this.api('answerCallbackQuery', {
        callback_query_id: callbackQueryId,
        text: text ?? '',
      });
    } catch (e) {
      // Non-fatal — Telegram permits the callback to be unanswered.
      console.error('[telegram] answerCallbackQuery failed:', (e as Error).message);
    }
  }

  async sendMedia(
    chatId: string,
    kind: MediaKind,
    buf: Buffer,
    filename: string,
    mimeType: string,
    caption?: string,
    opts: { replyMarkup?: InlineKeyboardMarkup } = {},
  ): Promise<TelegramMessage> {
    if (!this.token) throw new Error('telegram not configured');
    if (!this.chats.has(chatId)) this.addChat(chatId);
    const spec = SEND_METHOD_BY_KIND[kind];
    if (!spec) throw new Error(`unsupported send kind: ${kind}`);

    const form = new FormData();
    form.set('chat_id', chatId);
    if (caption) form.set('caption', caption);
    if (opts.replyMarkup) form.set('reply_markup', JSON.stringify(opts.replyMarkup));
    form.set(spec.field, new Blob([new Uint8Array(buf)], { type: mimeType }), filename);

    const url = `https://api.telegram.org/bot${this.token}/${spec.method}`;
    const res = await fetch(url, { method: 'POST', body: form });
    const json: any = await res.json();
    if (!json.ok) throw new Error(json.description || `telegram ${spec.method} failed`);
    const m = json.result;
    const msg: TelegramMessage = {
      id: m.message_id,
      chatId,
      from: 'bot',
      text: m.caption ?? '',
      date: m.date ?? Math.floor(Date.now() / 1000),
      senderName: this.botUsername ?? this.botFirstName ?? 'bot',
      media: extractMedia(m),
    };
    this.recordMessage(msg);
    return msg;
  }

  async resolveFile(fileId: string): Promise<{ url: string; filePath: string }> {
    if (!this.token) throw new Error('telegram not configured');
    const info = await this.api('getFile', { file_id: fileId });
    const filePath = info.file_path as string;
    return {
      filePath,
      url: `https://api.telegram.org/file/bot${this.token}/${filePath}`,
    };
  }

  async fetchFile(fileId: string): Promise<{ stream: Readable; contentType: string; size?: number }> {
    const { url, filePath } = await this.resolveFile(fileId);
    const res = await fetch(url);
    if (!res.ok || !res.body) throw new Error(`telegram file fetch failed: ${res.status}`);
    const contentType = res.headers.get('content-type') || guessMime(filePath);
    const sizeHeader = res.headers.get('content-length');
    const size = sizeHeader ? Number(sizeHeader) : undefined;
    const { Readable } = await import('node:stream');
    const stream = Readable.fromWeb(res.body as any);
    return { stream, contentType, size };
  }

  private recordMessage(msg: TelegramMessage) {
    if (!this.chats.has(msg.chatId)) return;
    const list = this.messages.get(msg.chatId) ?? [];
    list.push(msg);
    const cutoff = Math.floor(Date.now() / 1000) - RETENTION_SECONDS;
    while (list.length > 0 && list[0].date < cutoff) list.shift();
    this.messages.set(msg.chatId, list);
    void this.store.appendMessage(msg);
    this.emit('message', msg);
  }

  private async poll() {
    while (this.polling) {
      try {
        const updates = await this.api(
          'getUpdates',
          {
            offset: this.offset,
            timeout: 25,
            allowed_updates: [
              'message',
              'channel_post',
              'edited_message',
              'edited_channel_post',
              'callback_query',
            ],
          },
          35000,
        );
        for (const u of updates) {
          this.offset = u.update_id + 1;
          if (u.callback_query) {
            const cb = u.callback_query;
            const evt: TelegramCallback = {
              id: String(cb.id),
              chatId: String(cb.message?.chat?.id ?? ''),
              messageId: Number(cb.message?.message_id ?? 0),
              data: String(cb.data ?? ''),
              from: cb.from
                ? {
                    id: String(cb.from.id),
                    name:
                      [cb.from.first_name, cb.from.last_name].filter(Boolean).join(' ') ||
                      cb.from.username,
                  }
                : undefined,
            };
            this.emit('callback', evt);
            continue;
          }
          const m = u.message ?? u.channel_post ?? u.edited_message ?? u.edited_channel_post;
          if (!m) continue;
          const chatId = String(m.chat.id);
          let chat = this.chats.get(chatId);
          const inferredTitle: string | undefined =
            m.chat.title ||
            [m.chat.first_name, m.chat.last_name].filter(Boolean).join(' ') ||
            m.chat.username ||
            undefined;
          if (!chat) {
            chat = this.addChat(chatId);
            if (inferredTitle) {
              chat.title = inferredTitle;
              this.emit('chat:update', chat);
              void this.persistChats();
            }
          } else if (inferredTitle && chat.title !== inferredTitle) {
            chat.title = inferredTitle;
            this.emit('chat:update', chat);
            void this.persistChats();
          }
          const text: string = m.text ?? m.caption ?? '';
          const media = extractMedia(m);
          if (!text && !media) continue;
          const senderName = m.from
            ? [m.from.first_name, m.from.last_name].filter(Boolean).join(' ') ||
              m.from.username ||
              undefined
            : m.chat.title;
          this.recordMessage({
            id: m.message_id,
            chatId,
            from: 'user',
            text,
            date: m.date,
            senderName,
            media,
          });
        }
      } catch (e) {
        if (this.polling) {
          console.error('[telegram] poll error:', (e as Error).message);
          await sleep(2000);
        }
      }
    }
  }

  private async api(method: string, body: unknown, timeoutMs = 30000): Promise<any> {
    if (!this.token) throw new Error('no token');
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      const json: any = await res.json();
      if (!json.ok) throw new Error(json.description || `telegram ${method} failed`);
      return json.result;
    } finally {
      clearTimeout(t);
    }
  }
}

function extractMedia(m: any): TelegramMedia | undefined {
  if (m.photo && Array.isArray(m.photo) && m.photo.length > 0) {
    const largest = m.photo[m.photo.length - 1];
    return {
      kind: 'photo',
      fileId: largest.file_id,
      width: largest.width,
      height: largest.height,
      size: largest.file_size,
      mimeType: 'image/jpeg',
    };
  }
  if (m.video) {
    return {
      kind: 'video',
      fileId: m.video.file_id,
      mimeType: m.video.mime_type,
      fileName: m.video.file_name,
      width: m.video.width,
      height: m.video.height,
      duration: m.video.duration,
      size: m.video.file_size,
      thumbFileId: m.video.thumbnail?.file_id ?? m.video.thumb?.file_id,
    };
  }
  if (m.animation) {
    return {
      kind: 'animation',
      fileId: m.animation.file_id,
      mimeType: m.animation.mime_type ?? 'video/mp4',
      fileName: m.animation.file_name,
      width: m.animation.width,
      height: m.animation.height,
      duration: m.animation.duration,
      size: m.animation.file_size,
      thumbFileId: m.animation.thumbnail?.file_id,
    };
  }
  if (m.audio) {
    return {
      kind: 'audio',
      fileId: m.audio.file_id,
      mimeType: m.audio.mime_type ?? 'audio/mpeg',
      fileName: m.audio.file_name ?? m.audio.title,
      duration: m.audio.duration,
      size: m.audio.file_size,
    };
  }
  if (m.voice) {
    return {
      kind: 'voice',
      fileId: m.voice.file_id,
      mimeType: m.voice.mime_type ?? 'audio/ogg',
      duration: m.voice.duration,
      size: m.voice.file_size,
    };
  }
  if (m.video_note) {
    return {
      kind: 'video_note',
      fileId: m.video_note.file_id,
      mimeType: 'video/mp4',
      duration: m.video_note.duration,
      size: m.video_note.file_size,
      thumbFileId: m.video_note.thumbnail?.file_id,
    };
  }
  if (m.sticker) {
    return {
      kind: 'sticker',
      fileId: m.sticker.file_id,
      mimeType: m.sticker.is_animated || m.sticker.is_video ? 'video/webm' : 'image/webp',
      width: m.sticker.width,
      height: m.sticker.height,
      size: m.sticker.file_size,
      thumbFileId: m.sticker.thumbnail?.file_id,
    };
  }
  if (m.document) {
    return {
      kind: 'document',
      fileId: m.document.file_id,
      mimeType: m.document.mime_type,
      fileName: m.document.file_name,
      size: m.document.file_size,
      thumbFileId: m.document.thumbnail?.file_id,
    };
  }
  return undefined;
}

function guessMime(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  switch (ext) {
    case 'jpg':
    case 'jpeg': return 'image/jpeg';
    case 'png': return 'image/png';
    case 'gif': return 'image/gif';
    case 'webp': return 'image/webp';
    case 'mp4': return 'video/mp4';
    case 'mov': return 'video/quicktime';
    case 'webm': return 'video/webm';
    case 'mp3': return 'audio/mpeg';
    case 'ogg':
    case 'oga': return 'audio/ogg';
    case 'm4a': return 'audio/mp4';
    case 'wav': return 'audio/wav';
    case 'pdf': return 'application/pdf';
    default: return 'application/octet-stream';
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
