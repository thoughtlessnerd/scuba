import { useMemo } from 'react';
import type { GroupInfo, GroupType, SessionInfo } from '../types';
import { TerminalPane } from './TerminalPane';
import { EditableLabel } from './EditableLabel';
import { sessionLabel } from '../labels';

interface Props {
  sessions: SessionInfo[];
  groups: GroupInfo[];
  activeGroupId: string;
  ungroupedKey: string;
  activeSessionId: string | null;
  onSelect: (id: string) => void;
  onRenameSession: (id: string, name: string) => void;
}

interface GroupBucket {
  key: string;
  groupId: string | null;
  type: GroupType;
  color: string;
  sessions: SessionInfo[];
}

export function Workspace(props: Props) {
  const buckets = useMemo<GroupBucket[]>(() => {
    const result: GroupBucket[] = [];
    const ungrouped = props.sessions.filter((s) => !s.groupId && !s.hidden);
    result.push({
      key: props.ungroupedKey,
      groupId: null,
      type: 'tabs',
      color: '#3a4050',
      sessions: ungrouped,
    });
    for (const g of props.groups) {
      if (g.hidden) continue;
      result.push({
        key: g.id,
        groupId: g.id,
        type: g.type,
        color: g.color,
        sessions: props.sessions.filter((s) => s.groupId === g.id && !s.hidden),
      });
    }
    return result;
  }, [props.sessions, props.groups, props.ungroupedKey]);

  const totalSessions = props.sessions.filter((s) => !s.hidden).length;
  if (totalSessions === 0) {
    return (
      <main className="workspace">
        <div className="empty">Spawn a terminal to get started.</div>
      </main>
    );
  }

  return (
    <main className="workspace">
      {buckets.map((b) => (
        <GroupView
          key={b.key}
          bucket={b}
          isActiveGroup={b.key === props.activeGroupId}
          activeSessionId={props.activeSessionId}
          onSelect={props.onSelect}
          onRenameSession={props.onRenameSession}
        />
      ))}
    </main>
  );
}

interface GroupViewProps {
  bucket: GroupBucket;
  isActiveGroup: boolean;
  activeSessionId: string | null;
  onSelect: (id: string) => void;
  onRenameSession: (id: string, name: string) => void;
}

function GroupView({
  bucket,
  isActiveGroup,
  activeSessionId,
  onSelect,
  onRenameSession,
}: GroupViewProps) {
  const { type, color, sessions } = bucket;

  const gridStyle = useMemo(() => {
    if (type !== 'tiled') return undefined;
    const n = sessions.length || 1;
    const cols = Math.min(3, Math.ceil(Math.sqrt(n)));
    const rows = Math.ceil(n / cols);
    return {
      gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
      gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))`,
    };
  }, [type, sessions.length]);

  const groupStyle = isActiveGroup ? undefined : { display: 'none' as const };

  if (sessions.length === 0) {
    return (
      <div className="group-view" style={groupStyle}>
        <div className="empty">No visible terminals in this group.</div>
      </div>
    );
  }

  return (
    <div
      className="group-view"
      style={{ ...(groupStyle ?? {}), ['--group-color' as never]: color }}
    >
      {type === 'tabs' && (
        <div className="tabs-bar">
          {sessions.map((s) => (
            <div
              key={s.id}
              className={`tab ${s.id === activeSessionId ? 'active' : ''}`}
              onClick={() => onSelect(s.id)}
              title={`${s.cwd} (double-click to rename)`}
            >
              <EditableLabel
                value={sessionLabel(s)}
                placeholder="terminal"
                onCommit={(next) => onRenameSession(s.id, next)}
              />
            </div>
          ))}
        </div>
      )}

      <div className={`panes ${type}`} style={gridStyle}>
        {sessions.map((s) => {
          const isActiveSession = type === 'tiled' || s.id === activeSessionId;
          return (
            <div
              key={s.id}
              className={`pane ${s.id === activeSessionId ? 'active' : ''}`}
              onMouseDown={() => type === 'tiled' && onSelect(s.id)}
            >
              {type === 'tiled' && (
                <div className="pane-header" title={`${s.cwd} (double-click to rename)`}>
                  <EditableLabel
                    value={sessionLabel(s)}
                    placeholder="terminal"
                    onCommit={(next) => onRenameSession(s.id, next)}
                  />
                </div>
              )}
              <TerminalPane sessionId={s.id} active={isActiveGroup && isActiveSession} />
            </div>
          );
        })}
      </div>
    </div>
  );
}
