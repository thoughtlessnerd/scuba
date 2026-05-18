import { useEffect, useMemo, useState } from 'react';
import type { GroupInfo, GroupType, SessionInfo } from '../types';
import { EditableLabel } from './EditableLabel';
import { ColorSwatch } from './ColorSwatch';
import { EyeIcon, EyeOffIcon, ChevronIcon, PlusIcon, SettingsIcon } from './Icons';
import { sessionLabel } from '../labels';
import { NewClaudeModal } from './NewClaudeModal';
import { SettingsModal } from './SettingsModal';
import * as api from '../api';

interface Props {
  sessions: SessionInfo[];
  groups: GroupInfo[];
  activeGroupId: string;
  activeSessionId: string | null;
  ungroupedKey: string;
  onSelectGroup: (id: string) => void;
  onSelectSession: (id: string) => void;
  onSpawn: (cwd: string) => Promise<void>;
  onSpawnedClaude: () => void;
  onKillSession: (id: string) => void;
  onPatchSession: (
    id: string,
    patch: Partial<Pick<SessionInfo, 'name' | 'hidden' | 'groupId'>>,
  ) => void;
  onNewGroup: (type: GroupType) => Promise<void>;
  onPatchGroup: (
    id: string,
    patch: Partial<Pick<GroupInfo, 'name' | 'color' | 'type' | 'hidden'>>,
  ) => void;
  onRemoveGroup: (id: string) => void;
}

export function Sidebar(props: Props) {
  const {
    sessions,
    groups,
    activeGroupId,
    activeSessionId,
    ungroupedKey,
    onSelectGroup,
    onSelectSession,
    onSpawn,
    onKillSession,
    onPatchSession,
    onNewGroup,
    onPatchGroup,
    onRemoveGroup,
    onSpawnedClaude,
  } = props;

  const [cwd, setCwd] = useState('~');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [showClaudeModal, setShowClaudeModal] = useState(false);
  const [showSettings, setShowSettings] = useState(false);

  const sessionsByGroup = useMemo(() => {
    const map = new Map<string, SessionInfo[]>();
    map.set(ungroupedKey, []);
    for (const g of groups) map.set(g.id, []);
    for (const s of sessions) {
      const key = s.groupId ?? ungroupedKey;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(s);
    }
    return map;
  }, [sessions, groups, ungroupedKey]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await onSpawn(cwd.trim() || '~');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const toggle = (key: string) => setCollapsed((m) => ({ ...m, [key]: !m[key] }));

  return (
    <aside className="sidebar">
      <header>
        <h1>scuba</h1>
        <MotherButton />
        <button className="ghost-btn" onClick={() => onNewGroup('tabs')} title="New group">
          <PlusIcon /> Group
        </button>
        <button
          className="icon-btn"
          onClick={() => setShowSettings(true)}
          title="Settings"
          aria-label="Open settings"
        >
          <SettingsIcon />
        </button>
      </header>

      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}

      <form className="spawn-form" onSubmit={submit}>
        <input
          type="text"
          value={cwd}
          onChange={(e) => setCwd(e.target.value)}
          placeholder="/path/to/folder or ~"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
        />
        <div className="spawn-actions">
          <button type="submit" disabled={busy}>
            {busy ? 'Spawning…' : 'New terminal'}
          </button>
          <button
            type="button"
            className="claude-btn"
            disabled={busy}
            onClick={() => { setError(null); setShowClaudeModal(true); }}
          >
            New claude
          </button>
        </div>
        {error && <div className="err">{error}</div>}
      </form>

      {showClaudeModal && (
        <NewClaudeModal
          initialCwd={cwd}
          onCancel={() => setShowClaudeModal(false)}
          onSpawned={() => { setShowClaudeModal(false); onSpawnedClaude(); }}
        />
      )}

      <div className="tree">
        <GroupSection
          key={ungroupedKey}
          ungrouped
          title="Ungrouped"
          color="#3a4050"
          type="tabs"
          hidden={false}
          collapsed={!!collapsed[ungroupedKey]}
          active={activeGroupId === ungroupedKey}
          sessions={sessionsByGroup.get(ungroupedKey) ?? []}
          activeSessionId={activeSessionId}
          groups={groups}
          onToggleCollapse={() => toggle(ungroupedKey)}
          onSelectGroup={() => onSelectGroup(ungroupedKey)}
          onSelectSession={onSelectSession}
          onPatchSession={onPatchSession}
          onKillSession={onKillSession}
        />

        {groups.map((g) => (
          <GroupSection
            key={g.id}
            ungrouped={false}
            title={g.name}
            color={g.color}
            type={g.type}
            hidden={g.hidden}
            collapsed={!!collapsed[g.id]}
            active={activeGroupId === g.id}
            sessions={sessionsByGroup.get(g.id) ?? []}
            activeSessionId={activeSessionId}
            groups={groups}
            onToggleCollapse={() => toggle(g.id)}
            onSelectGroup={() => onSelectGroup(g.id)}
            onSelectSession={onSelectSession}
            onPatchSession={onPatchSession}
            onKillSession={onKillSession}
            onRenameGroup={(name) => onPatchGroup(g.id, { name })}
            onChangeColor={(color) => onPatchGroup(g.id, { color })}
            onChangeType={(type) => onPatchGroup(g.id, { type })}
            onToggleHidden={() => onPatchGroup(g.id, { hidden: !g.hidden })}
            onDelete={() => onRemoveGroup(g.id)}
          />
        ))}
      </div>
    </aside>
  );
}

interface GroupSectionProps {
  ungrouped: boolean;
  title: string;
  color: string;
  type: GroupType;
  hidden: boolean;
  collapsed: boolean;
  active: boolean;
  sessions: SessionInfo[];
  activeSessionId: string | null;
  groups: GroupInfo[];
  onToggleCollapse: () => void;
  onSelectGroup: () => void;
  onSelectSession: (id: string) => void;
  onPatchSession: Props['onPatchSession'];
  onKillSession: (id: string) => void;
  onRenameGroup?: (name: string) => void;
  onChangeColor?: (color: string) => void;
  onChangeType?: (type: GroupType) => void;
  onToggleHidden?: () => void;
  onDelete?: () => void;
}

function GroupSection(p: GroupSectionProps) {
  return (
    <div className={`group ${p.hidden ? 'is-hidden' : ''} ${p.active ? 'is-active' : ''}`}>
      <div
        className="group-header"
        onClick={p.onSelectGroup}
        style={{ borderLeftColor: p.color }}
      >
        <button
          className="chev-btn"
          onClick={(e) => {
            e.stopPropagation();
            p.onToggleCollapse();
          }}
        >
          <ChevronIcon open={!p.collapsed} />
        </button>

        {p.onToggleHidden ? (
          <button
            className="icon-btn"
            onClick={(e) => {
              e.stopPropagation();
              p.onToggleHidden!();
            }}
            title={p.hidden ? 'Show group' : 'Hide group'}
          >
            {p.hidden ? <EyeOffIcon /> : <EyeIcon />}
          </button>
        ) : (
          <span className="icon-btn placeholder" />
        )}

        {p.onChangeColor ? (
          <ColorSwatch color={p.color} onChange={p.onChangeColor} />
        ) : (
          <span className="color-swatch placeholder" style={{ background: p.color }} />
        )}

        {p.ungrouped ? (
          <span className="group-name">{p.title}</span>
        ) : (
          <EditableLabel
            className="group-name"
            value={p.title}
            placeholder="Group"
            onCommit={(next) => p.onRenameGroup?.(next)}
          />
        )}

        <span className="group-count">{p.sessions.length}</span>

        {p.onChangeType && (
          <button
            className="type-pill"
            onClick={(e) => {
              e.stopPropagation();
              p.onChangeType!(p.type === 'tabs' ? 'tiled' : 'tabs');
            }}
            title="Toggle layout"
          >
            {p.type}
          </button>
        )}

        {p.onDelete && (
          <button
            className="icon-btn danger"
            onClick={(e) => {
              e.stopPropagation();
              if (confirm('Delete group? Terminals will move to Ungrouped.')) p.onDelete!();
            }}
            title="Delete group"
          >
            ✕
          </button>
        )}
      </div>

      {!p.collapsed && (
        <div className="group-body">
          {p.sessions.length === 0 && (
            <div className="empty-row">no terminals</div>
          )}
          {p.sessions.map((s) => (
            <SessionRow
              key={s.id}
              session={s}
              groups={p.groups}
              active={s.id === p.activeSessionId}
              onSelect={() => p.onSelectSession(s.id)}
              onPatch={(patch) => p.onPatchSession(s.id, patch)}
              onKill={() => p.onKillSession(s.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

interface SessionRowProps {
  session: SessionInfo;
  groups: GroupInfo[];
  active: boolean;
  onSelect: () => void;
  onPatch: (patch: Partial<Pick<SessionInfo, 'name' | 'hidden' | 'groupId'>>) => void;
  onKill: () => void;
}

/**
 * Compact mother-status button in the sidebar header. Replaces the
 * empty-state "Spawn mother claude" CTA so the control stays reachable
 * once other terminals exist.
 */
function MotherButton() {
  const [status, setStatus] = useState<api.MotherStatus | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    try { setStatus(await api.getMotherStatus()); } catch {}
  };

  useEffect(() => {
    void refresh();
    const id = setInterval(refresh, 1500);
    return () => clearInterval(id);
  }, []);

  if (!status) return null;
  if (!status.configured) {
    return (
      <button
        className="ghost-btn mother-btn disabled"
        title="Set MOTHER_TELEGRAM_CHAT_ID in .env to enable mother"
        disabled
      >
        Mother: off
      </button>
    );
  }

  const onClick = async () => {
    if (status.alive && !confirm('Mother is already running. Restart her?')) return;
    setBusy(true);
    try { await api.spawnMother(); await refresh(); }
    catch (err) { alert((err as Error).message); }
    finally { setBusy(false); }
  };

  return (
    <button
      className={`ghost-btn mother-btn ${status.alive ? 'alive' : ''}`}
      disabled={busy}
      onClick={onClick}
      title={status.alive ? 'Mother is running — click to restart' : 'Spawn mother claude'}
    >
      {busy ? '…' : status.alive ? 'Mother: live' : 'Spawn mother'}
    </button>
  );
}

function SessionRow({ session, groups, active, onSelect, onPatch, onKill }: SessionRowProps) {
  return (
    <div
      className={`session-row ${active ? 'active' : ''} ${session.hidden ? 'is-hidden' : ''}`}
      onClick={onSelect}
    >
      <button
        className="icon-btn"
        onClick={(e) => {
          e.stopPropagation();
          onPatch({ hidden: !session.hidden });
        }}
        title={session.hidden ? 'Show terminal' : 'Hide terminal'}
      >
        {session.hidden ? <EyeOffIcon /> : <EyeIcon />}
      </button>

      <EditableLabel
        className="cwd"
        title={`${session.cwd} (double-click to rename)`}
        value={sessionLabel(session)}
        placeholder="terminal"
        onCommit={(next) => onPatch({ name: next })}
      />

      <select
        className="move-select"
        value={session.groupId ?? ''}
        onChange={(e) => onPatch({ groupId: e.target.value || null })}
        onClick={(e) => e.stopPropagation()}
        title="Move to group"
      >
        <option value="">Ungrouped</option>
        {groups.map((g) => (
          <option key={g.id} value={g.id}>{g.name}</option>
        ))}
      </select>

      <button
        className="icon-btn danger"
        onClick={(e) => {
          e.stopPropagation();
          onKill();
        }}
        title="Kill terminal"
      >
        ✕
      </button>
    </div>
  );
}
