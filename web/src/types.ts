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
