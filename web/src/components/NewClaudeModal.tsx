import { useEffect, useState } from 'react';
import * as api from '../api';
import type { TelegramChat } from '../types';

interface Props {
  initialCwd: string;
  onCancel: () => void;
  onSpawned: () => void;
}

/**
 * Modal for spawning an adhoc claude. The user picks the Telegram chat that
 * permission prompts will route to and from which they'll be able to send
 * input to this terminal. Mother's chat is excluded — it's reserved for her.
 */
export function NewClaudeModal({ initialCwd, onCancel, onSpawned }: Props) {
  const [cwd, setCwd] = useState(initialCwd);
  const [name, setName] = useState('claude');
  const [chats, setChats] = useState<TelegramChat[] | null>(null);
  const [chatId, setChatId] = useState<string>('');
  const [motherChatId, setMotherChatId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      api.listTelegramChats(),
      api.getMotherStatus().catch(() => null),
      api.listBoundChatIds().catch(() => [] as string[]),
    ])
      .then(([list, mother, bound]) => {
        if (cancelled) return;
        const motherId = mother?.record?.chatId ?? null;
        setMotherChatId(motherId);
        const boundSet = new Set(bound);
        if (motherId) boundSet.add(motherId);
        const filtered = list.filter((c) => !boundSet.has(c.chatId));
        setChats(filtered);
        if (filtered.length > 0) setChatId(filtered[0].chatId);
      })
      .catch((err) => { if (!cancelled) setError((err as Error).message); });
    return () => { cancelled = true; };
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!chatId) {
      setError('pick a chat');
      return;
    }
    setBusy(true);
    try {
      await api.spawnAdhocClaude({ cwd: cwd.trim() || '~', chatId, name: name.trim() || 'claude' });
      onSpawned();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <div className="modal-title">New claude</div>
        <div className="modal-sub">
          An isolated claude session — bound to a Telegram chat for human input.
        </div>

        <label className="modal-field">
          <span>cwd</span>
          <input
            type="text"
            value={cwd}
            onChange={(e) => setCwd(e.target.value)}
            placeholder="/path or ~"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
          />
        </label>

        <label className="modal-field">
          <span>name</span>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={15}
            spellCheck={false}
          />
        </label>

        <label className="modal-field">
          <span>chat</span>
          {chats === null ? (
            <div className="modal-hint">loading chats…</div>
          ) : chats.length === 0 ? (
            <div className="modal-hint">
              No unbound Telegram chats available. Every tracked chat is already
              mapped to an agent terminal{motherChatId ? ' (or to mother)' : ''}.
              Add a new chat in the Telegram panel.
            </div>
          ) : (
            <select value={chatId} onChange={(e) => setChatId(e.target.value)}>
              {chats.map((c) => (
                <option key={c.chatId} value={c.chatId}>
                  {c.title ?? c.label ?? c.chatId} · {c.chatId}
                </option>
              ))}
            </select>
          )}
        </label>

        {error && <div className="modal-err">{error}</div>}

        <div className="modal-actions">
          <button type="button" className="ghost-btn" onClick={onCancel}>Cancel</button>
          <button type="submit" disabled={busy || !chatId}>
            {busy ? 'Spawning…' : 'Spawn claude'}
          </button>
        </div>
      </form>
    </div>
  );
}
