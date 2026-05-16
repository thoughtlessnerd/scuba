import { useCallback, useEffect, useMemo, useState } from 'react';
import { Sidebar } from './components/Sidebar';
import { Workspace } from './components/Workspace';
import * as api from './api';
import type { GroupInfo, GroupType, SessionInfo } from './types';

const UNGROUPED_KEY = '__ungrouped__';

export default function App() {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [groups, setGroups] = useState<GroupInfo[]>([]);
  const [activeGroupId, setActiveGroupId] = useState<string>(UNGROUPED_KEY);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([api.listSessions(), api.listGroups()])
      .then(([s, g]) => {
        setSessions(s);
        setGroups(g);
        const first = s.find((x) => !x.hidden);
        if (first) {
          setActiveSessionId(first.id);
          setActiveGroupId(first.groupId ?? UNGROUPED_KEY);
        }
      })
      .catch(() => {});
  }, []);

  const activeGroupIdOrNull = activeGroupId === UNGROUPED_KEY ? null : activeGroupId;

  const spawn = useCallback(
    async (cwd: string) => {
      const info = await api.createSession(cwd, activeGroupIdOrNull);
      setSessions((prev) => [...prev, info]);
      setActiveSessionId(info.id);
    },
    [activeGroupIdOrNull],
  );

  const killSession = useCallback(async (id: string) => {
    await api.killSession(id);
    setSessions((prev) => {
      const next = prev.filter((s) => s.id !== id);
      setActiveSessionId((curr) =>
        curr === id ? next.find((s) => !s.hidden)?.id ?? null : curr,
      );
      return next;
    });
  }, []);

  const patchSession = useCallback(
    async (id: string, patch: Partial<Pick<SessionInfo, 'name' | 'hidden' | 'groupId'>>) => {
      setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, ...patch } : s)));
      try {
        await api.updateSession(id, patch);
      } catch {}
    },
    [],
  );

  const newGroup = useCallback(async (type: GroupType) => {
    const g = await api.createGroup({ type });
    setGroups((prev) => [...prev, g]);
    setActiveGroupId(g.id);
  }, []);

  const patchGroup = useCallback(
    async (id: string, patch: Partial<Pick<GroupInfo, 'name' | 'color' | 'type' | 'hidden'>>) => {
      setGroups((prev) => prev.map((g) => (g.id === id ? { ...g, ...patch } : g)));
      try {
        await api.updateGroup(id, patch);
      } catch {}
    },
    [],
  );

  const removeGroup = useCallback(async (id: string) => {
    await api.deleteGroup(id);
    setGroups((prev) => prev.filter((g) => g.id !== id));
    setSessions((prev) => prev.map((s) => (s.groupId === id ? { ...s, groupId: null } : s)));
    setActiveGroupId((curr) => (curr === id ? UNGROUPED_KEY : curr));
  }, []);

  const activeGroup = useMemo<GroupInfo | null>(
    () => groups.find((g) => g.id === activeGroupIdOrNull) ?? null,
    [groups, activeGroupIdOrNull],
  );

  useEffect(() => {
    if (activeGroup?.hidden) setActiveGroupId(UNGROUPED_KEY);
  }, [activeGroup]);

  const visibleInActiveGroup = useMemo(
    () =>
      sessions
        .filter((s) => (s.groupId ?? null) === activeGroupIdOrNull)
        .filter((s) => !s.hidden),
    [sessions, activeGroupIdOrNull],
  );

  useEffect(() => {
    if (activeSessionId && visibleInActiveGroup.some((s) => s.id === activeSessionId)) return;
    setActiveSessionId(visibleInActiveGroup[0]?.id ?? null);
  }, [visibleInActiveGroup, activeSessionId]);

  return (
    <div className="app">
      <Sidebar
        sessions={sessions}
        groups={groups}
        activeGroupId={activeGroupId}
        activeSessionId={activeSessionId}
        ungroupedKey={UNGROUPED_KEY}
        onSelectGroup={setActiveGroupId}
        onSelectSession={(sid) => {
          const s = sessions.find((x) => x.id === sid);
          if (!s) return;
          setActiveGroupId(s.groupId ?? UNGROUPED_KEY);
          setActiveSessionId(sid);
        }}
        onSpawn={spawn}
        onKillSession={killSession}
        onPatchSession={patchSession}
        onNewGroup={newGroup}
        onPatchGroup={patchGroup}
        onRemoveGroup={removeGroup}
      />
      <Workspace
        sessions={sessions}
        groups={groups}
        activeGroupId={activeGroupId}
        ungroupedKey={UNGROUPED_KEY}
        activeSessionId={activeSessionId}
        onSelect={setActiveSessionId}
        onRenameSession={(id, name) => patchSession(id, { name })}
      />
    </div>
  );
}
