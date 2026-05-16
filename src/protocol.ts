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
