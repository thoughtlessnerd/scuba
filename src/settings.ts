import type { AgentStore } from './agent-store.js';
import { MOTHER_SYSTEM_PROMPT, DEFAULT_WORKER_SYSTEM_PROMPT } from './mother-prompt.js';

export type PermissionMode = 'acceptEdits' | 'bypassPermissions';

export interface SettingsValues {
  motherSystemPrompt: string;
  workerSystemPrompt: string;
  adhocSystemPrompt: string;
  permissionMode: PermissionMode;
  turnEndDebounceMs: number;
}

export interface SettingsDefaults extends SettingsValues {}

const KEYS = {
  motherSystemPrompt: 'mother_system_prompt',
  workerSystemPrompt: 'worker_system_prompt',
  adhocSystemPrompt: 'adhoc_system_prompt',
  permissionMode: 'permission_mode',
  turnEndDebounceMs: 'turn_end_debounce_ms',
} as const;

function envDebounce(): number {
  const raw = Number(process.env.TURN_END_DEBOUNCE_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 1500;
}

export function buildDefaults(): SettingsDefaults {
  return {
    motherSystemPrompt: MOTHER_SYSTEM_PROMPT,
    workerSystemPrompt: DEFAULT_WORKER_SYSTEM_PROMPT,
    adhocSystemPrompt: '',
    permissionMode: 'acceptEdits',
    turnEndDebounceMs: envDebounce(),
  };
}

export class Settings {
  private cache: SettingsValues;
  readonly defaults: SettingsDefaults;

  constructor(private readonly store: AgentStore) {
    this.defaults = buildDefaults();
    this.cache = this.load();
  }

  private load(): SettingsValues {
    const raw = this.store.getAllSettings();
    const mode = raw[KEYS.permissionMode];
    const debounce = Number(raw[KEYS.turnEndDebounceMs]);
    return {
      motherSystemPrompt: raw[KEYS.motherSystemPrompt] ?? this.defaults.motherSystemPrompt,
      workerSystemPrompt: raw[KEYS.workerSystemPrompt] ?? this.defaults.workerSystemPrompt,
      adhocSystemPrompt: raw[KEYS.adhocSystemPrompt] ?? this.defaults.adhocSystemPrompt,
      permissionMode: mode === 'bypassPermissions' ? 'bypassPermissions' : 'acceptEdits',
      turnEndDebounceMs: Number.isFinite(debounce) && debounce >= 0 ? debounce : this.defaults.turnEndDebounceMs,
    };
  }

  values(): SettingsValues {
    return { ...this.cache };
  }

  get<K extends keyof SettingsValues>(key: K): SettingsValues[K] {
    return this.cache[key];
  }

  update(patch: Partial<SettingsValues>): SettingsValues {
    const next: SettingsValues = { ...this.cache };

    if (patch.motherSystemPrompt !== undefined) {
      next.motherSystemPrompt = String(patch.motherSystemPrompt);
      this.persist(KEYS.motherSystemPrompt, next.motherSystemPrompt, this.defaults.motherSystemPrompt);
    }
    if (patch.workerSystemPrompt !== undefined) {
      next.workerSystemPrompt = String(patch.workerSystemPrompt);
      this.persist(KEYS.workerSystemPrompt, next.workerSystemPrompt, this.defaults.workerSystemPrompt);
    }
    if (patch.adhocSystemPrompt !== undefined) {
      next.adhocSystemPrompt = String(patch.adhocSystemPrompt);
      this.persist(KEYS.adhocSystemPrompt, next.adhocSystemPrompt, this.defaults.adhocSystemPrompt);
    }
    if (patch.permissionMode !== undefined) {
      const mode: PermissionMode = patch.permissionMode === 'bypassPermissions' ? 'bypassPermissions' : 'acceptEdits';
      next.permissionMode = mode;
      this.persist(KEYS.permissionMode, mode, this.defaults.permissionMode);
    }
    if (patch.turnEndDebounceMs !== undefined) {
      const n = Number(patch.turnEndDebounceMs);
      if (!Number.isFinite(n) || n < 0) throw new Error('turnEndDebounceMs must be a non-negative number');
      next.turnEndDebounceMs = Math.floor(n);
      this.persist(KEYS.turnEndDebounceMs, String(next.turnEndDebounceMs), String(this.defaults.turnEndDebounceMs));
    }

    this.cache = next;
    return { ...next };
  }

  private persist(key: string, value: string, defaultValue: string): void {
    if (value === defaultValue) this.store.deleteSetting(key);
    else this.store.setSetting(key, value);
  }
}
