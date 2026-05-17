import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as api from '../api';
import type { TelegramChat, TelegramEvent, TelegramMedia, TelegramMessage, TelegramStatus } from '../types';

interface Props {
  collapsed: boolean;
  onToggle: () => void;
}

export function TelegramPanel({ collapsed, onToggle }: Props) {
  const [status, setStatus] = useState<TelegramStatus | null>(null);
  const [chats, setChats] = useState<TelegramChat[]>([]);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Record<string, TelegramMessage[]>>({});
  const [draft, setDraft] = useState('');
  const [adding, setAdding] = useState(false);
  const [addChatId, setAddChatId] = useState('');
  const [addLabel, setAddLabel] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [menuOpen]);

  useEffect(() => {
    api.getTelegramStatus().then(setStatus).catch(() => {});
    api.listTelegramChats().then((cs) => {
      setChats(cs);
      if (cs.length > 0) setActiveChatId((curr) => curr ?? cs[0].chatId);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    const ws = new WebSocket(api.telegramSocketUrl());
    wsRef.current = ws;
    ws.onmessage = (e) => {
      let evt: TelegramEvent;
      try { evt = JSON.parse(e.data); } catch { return; }
      if (evt.type === 'hello') {
        setStatus({ enabled: evt.enabled, bot: evt.bot ?? {} });
      } else if (evt.type === 'chat:add') {
        setChats((prev) => prev.some((c) => c.chatId === evt.chat.chatId) ? prev : [...prev, evt.chat]);
        setActiveChatId((curr) => curr ?? evt.chat.chatId);
      } else if (evt.type === 'chat:update') {
        setChats((prev) => prev.map((c) => c.chatId === evt.chat.chatId ? evt.chat : c));
      } else if (evt.type === 'chat:remove') {
        setChats((prev) => prev.filter((c) => c.chatId !== evt.chatId));
        setMessages((prev) => { const n = { ...prev }; delete n[evt.chatId]; return n; });
        setActiveChatId((curr) => curr === evt.chatId ? null : curr);
      } else if (evt.type === 'message') {
        setMessages((prev) => {
          const list = prev[evt.message.chatId] ?? [];
          if (list.some((m) => m.id === evt.message.id && m.from === evt.message.from)) return prev;
          return { ...prev, [evt.message.chatId]: [...list, evt.message] };
        });
      }
    };
    return () => { ws.close(); };
  }, []);

  useEffect(() => {
    if (!activeChatId) return;
    if (messages[activeChatId]) return;
    api.getTelegramMessages(activeChatId)
      .then((ms) => setMessages((prev) => ({ ...prev, [activeChatId]: ms })))
      .catch(() => {});
  }, [activeChatId, messages]);

  const activeMessages = useMemo(
    () => (activeChatId ? messages[activeChatId] ?? [] : []),
    [activeChatId, messages],
  );

  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [activeMessages, activeChatId]);

  const addChat = useCallback(async () => {
    setError(null);
    try {
      const chat = await api.addTelegramChat(addChatId.trim(), addLabel.trim() || undefined);
      setChats((prev) => prev.some((c) => c.chatId === chat.chatId) ? prev : [...prev, chat]);
      setActiveChatId(chat.chatId);
      setAddChatId('');
      setAddLabel('');
      setAdding(false);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [addChatId, addLabel]);

  const deleteActive = useCallback(async () => {
    if (!activeChatId) return;
    if (!confirm('Delete this chat and all its history? This cannot be undone.')) return;
    await api.removeTelegramChat(activeChatId);
    setChats((prev) => prev.filter((c) => c.chatId !== activeChatId));
    setMessages((prev) => { const n = { ...prev }; delete n[activeChatId]; return n; });
    setActiveChatId(null);
    setMenuOpen(false);
  }, [activeChatId]);

  const clearActive = useCallback(async () => {
    if (!activeChatId) return;
    if (!confirm('Clear all messages in this chat? The chat itself stays.')) return;
    await api.clearTelegramMessages(activeChatId);
    setMessages((prev) => ({ ...prev, [activeChatId]: [] }));
    setMenuOpen(false);
  }, [activeChatId]);

  const refreshActive = useCallback(async () => {
    if (!activeChatId) return;
    try {
      const c = await api.refreshTelegramChat(activeChatId);
      setChats((prev) => prev.map((x) => x.chatId === c.chatId ? c : x));
    } catch (e) {
      setError((e as Error).message);
    }
    setMenuOpen(false);
  }, [activeChatId]);

  const send = useCallback(async () => {
    if (!activeChatId) return;
    const text = draft.trim();
    if (!text && !pendingFile) return;
    setSending(true);
    setError(null);
    try {
      if (pendingFile) {
        const kind = api.kindForFile(pendingFile);
        await api.sendTelegramMedia(activeChatId, pendingFile, kind, text || undefined);
        setPendingFile(null);
        if (fileInputRef.current) fileInputRef.current.value = '';
      } else {
        await api.sendTelegramMessage(activeChatId, text);
      }
      setDraft('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(false);
    }
  }, [activeChatId, draft, pendingFile]);

  const onPickFile = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) setPendingFile(f);
  }, []);

  if (collapsed) {
    return (
      <button className="tg-collapsed-btn" onClick={onToggle} title="Open Telegram panel">
        TG
      </button>
    );
  }

  const activeChat = chats.find((c) => c.chatId === activeChatId) ?? null;

  return (
    <aside className="tg-panel">
      <div className="tg-rail">
        {chats.map((c) => (
          <button
            key={c.chatId}
            className={`tg-rail-item ${c.chatId === activeChatId ? 'active' : ''}`}
            onClick={() => setActiveChatId(c.chatId)}
            style={!c.photoFileId ? { background: chatColor(c.chatId) } : undefined}
          >
            {c.photoFileId
              ? <img src={api.telegramFileUrl(c.photoFileId)} alt="" />
              : <span className="tg-rail-initials">{initials(chatTitle(c))}</span>}
            <span className="tg-rail-tooltip">{chatTitle(c)}</span>
          </button>
        ))}
        <button
          className="tg-rail-item tg-rail-add"
          onClick={() => setAdding(true)}
          disabled={!status?.enabled}
          title="Add chat"
        >
          +
          <span className="tg-rail-tooltip">Add chat</span>
        </button>
      </div>

      {adding && (
        <div className="tg-modal-backdrop" onClick={() => { setAdding(false); setError(null); }}>
          <div className="tg-modal" onClick={(e) => e.stopPropagation()}>
            <div className="tg-modal-title">Add a chat</div>
            <input
              placeholder="chat id (e.g. 123456 or -100123…)"
              value={addChatId}
              onChange={(e) => setAddChatId(e.target.value)}
              autoFocus
            />
            <input
              placeholder="label (optional)"
              value={addLabel}
              onChange={(e) => setAddLabel(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && addChatId.trim()) addChat(); }}
            />
            {error && <div className="tg-error" style={{ margin: 0 }}>{error}</div>}
            <div className="tg-modal-actions">
              <button className="ghost-btn" onClick={() => { setAdding(false); setError(null); }}>cancel</button>
              <button className="primary-btn" onClick={addChat} disabled={!addChatId.trim()}>add</button>
            </div>
          </div>
        </div>
      )}

      <div className="tg-phone">
        <header className="tg-header">
          <div className="tg-header-main">
            <div className="tg-title">
              {activeChat ? chatTitle(activeChat) : 'Telegram'}
            </div>
            <div className="tg-sub">
              {status?.enabled
                ? status.bot.username ? `@${status.bot.username}` : 'connected'
                : 'bot token not set'}
            </div>
          </div>
          <div className="tg-menu-wrap" ref={menuRef}>
            {activeChat && (
              <button
                className="icon-btn"
                onClick={() => setMenuOpen((v) => !v)}
                title="More"
              >⋯</button>
            )}
            {menuOpen && (
              <div className="tg-menu">
                <button onClick={refreshActive}>Refresh chat info</button>
                <button onClick={clearActive}>Clear messages</button>
                <button className="danger" onClick={deleteActive}>Delete chat</button>
              </div>
            )}
          </div>
          <button className="icon-btn" onClick={onToggle} title="Hide">×</button>
        </header>

        <div className="tg-messages" ref={scrollRef}>
          {!status?.enabled && (
            <div className="tg-empty">
              Set <code>TELEGRAM_BOT_TOKEN</code> in <code>.env</code> and restart scuba.
            </div>
          )}
          {status?.enabled && !activeChatId && (
            <div className="tg-empty">Add a chat ID to start.</div>
          )}
          {activeChatId && activeMessages.length === 0 && (
            <div className="tg-empty">No messages yet.</div>
          )}
          {activeMessages.map((m, i) => {
            const prev = activeMessages[i - 1];
            const showSender = m.from === 'user' && (!prev || prev.senderName !== m.senderName || prev.from !== 'user');
            return (
              <div key={`${m.from}-${m.id}-${i}`} className={`tg-msg ${m.from}`}>
                {showSender && m.senderName && <div className="tg-sender">{m.senderName}</div>}
                <div className={`tg-bubble ${m.media ? 'has-media' : ''}`}>
                  {m.media && <MediaView media={m.media} />}
                  {m.text && <div className="tg-text">{m.text}</div>}
                  {!m.text && !m.media && <em className="tg-muted">(empty)</em>}
                </div>
                <div className="tg-time">{fmtTime(m.date)}</div>
              </div>
            );
          })}
        </div>

        {error && <div className="tg-error">{error}</div>}

        {pendingFile && (
          <div className="tg-attach-preview">
            <span className="tg-attach-name">{pendingFile.name}</span>
            <span className="tg-attach-size">{fmtSize(pendingFile.size)}</span>
            <button
              className="icon-btn"
              onClick={() => {
                setPendingFile(null);
                if (fileInputRef.current) fileInputRef.current.value = '';
              }}
              title="Remove"
            >×</button>
          </div>
        )}

        <div className="tg-composer">
          <input
            ref={fileInputRef}
            type="file"
            style={{ display: 'none' }}
            onChange={onPickFile}
            accept="image/*,video/*,audio/*,application/pdf"
          />
          <button
            className="icon-btn tg-attach-btn"
            onClick={() => fileInputRef.current?.click()}
            disabled={!activeChatId || sending}
            title="Attach"
          >+</button>
          <textarea
            placeholder={
              !activeChatId ? 'Select a chat'
                : pendingFile ? 'Caption (optional)…'
                : 'Message…'
            }
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            disabled={!activeChatId || sending}
            rows={1}
          />
          <button
            className="primary-btn"
            onClick={send}
            disabled={!activeChatId || (!draft.trim() && !pendingFile) || sending}
          >send</button>
        </div>
      </div>
    </aside>
  );
}

function chatTitle(c: TelegramChat): string {
  return c.label || c.title || c.chatId;
}

function initials(s: string): string {
  const parts = s.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

const AVATAR_COLORS = ['#7aa2f7', '#9ece6a', '#e0af68', '#f7768e', '#bb9af7', '#7dcfff', '#ff9e64'];
function chatColor(chatId: string): string {
  let h = 0;
  for (let i = 0; i < chatId.length; i++) h = (h * 31 + chatId.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

function fmtTime(unix: number): string {
  const d = new Date(unix * 1000);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function fmtDuration(sec?: number): string {
  if (!sec) return '';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

function MediaView({ media }: { media: TelegramMedia }) {
  const src = api.telegramFileUrl(media.fileId);
  switch (media.kind) {
    case 'photo':
    case 'sticker':
      return <img className="tg-media-img" src={src} alt="" loading="lazy" />;
    case 'animation':
    case 'video':
    case 'video_note':
      return <video className="tg-media-video" src={src} controls preload="metadata" />;
    case 'audio':
    case 'voice':
      return (
        <div className="tg-media-audio">
          <audio src={src} controls preload="metadata" />
          <div className="tg-media-meta">
            {media.fileName ?? (media.kind === 'voice' ? 'voice note' : 'audio')}
            {media.duration ? ` · ${fmtDuration(media.duration)}` : ''}
          </div>
        </div>
      );
    case 'document':
    default:
      return (
        <a className="tg-media-file" href={src} target="_blank" rel="noreferrer" download={media.fileName}>
          <span className="tg-file-icon">📎</span>
          <span className="tg-file-info">
            <span className="tg-file-name">{media.fileName ?? 'file'}</span>
            {media.size && <span className="tg-file-size">{fmtSize(media.size)}</span>}
          </span>
        </a>
      );
  }
}
