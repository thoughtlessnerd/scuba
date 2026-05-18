import { useEffect, useState } from 'react';
import {
  getSettings,
  updateSettings,
  type PermissionMode,
  type SettingsValues,
} from '../api';

interface Props {
  onClose: () => void;
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; values: SettingsValues; defaults: SettingsValues };

export function SettingsModal({ onClose }: Props) {
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [draft, setDraft] = useState<SettingsValues | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    getSettings()
      .then((r) => {
        if (cancelled) return;
        setState({ kind: 'ready', values: r.values, defaults: r.defaults });
        setDraft(r.values);
      })
      .catch((err) => {
        if (cancelled) return;
        setState({ kind: 'error', message: (err as Error).message });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function field<K extends keyof SettingsValues>(key: K, value: SettingsValues[K]) {
    if (!draft) return;
    setDraft({ ...draft, [key]: value });
    setSavedAt(null);
  }

  async function save() {
    if (!draft || state.kind !== 'ready') return;
    setSaving(true);
    setSaveError(null);
    try {
      const r = await updateSettings(draft);
      setState({ kind: 'ready', values: r.values, defaults: r.defaults });
      setDraft(r.values);
      setSavedAt(Date.now());
    } catch (err) {
      setSaveError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  const dirty =
    draft && state.kind === 'ready'
      ? JSON.stringify(draft) !== JSON.stringify(state.values)
      : false;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal settings-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="settings-header">
          <h2>Settings</h2>
          <button className="modal-close" onClick={onClose} aria-label="Close">×</button>
        </div>

        {state.kind === 'loading' && <div className="settings-body">Loading…</div>}
        {state.kind === 'error' && (
          <div className="settings-body settings-error">Failed to load: {state.message}</div>
        )}

        {state.kind === 'ready' && draft && (
          <>
            <div className="settings-body">
              <PromptField
                label="Mother system prompt"
                help="Used when spawning mother. Takes effect on next mother spawn/restart."
                value={draft.motherSystemPrompt}
                defaultValue={state.defaults.motherSystemPrompt}
                onChange={(v) => field('motherSystemPrompt', v)}
              />
              <PromptField
                label="Default worker system prompt"
                help="Used when mother spawns a worker without overriding the prompt. Takes effect immediately for new workers."
                value={draft.workerSystemPrompt}
                defaultValue={state.defaults.workerSystemPrompt}
                onChange={(v) => field('workerSystemPrompt', v)}
              />
              <PromptField
                label="Default adhoc system prompt"
                help="Used when spawning an adhoc claude via the New claude modal. Blank = claude's default behavior."
                value={draft.adhocSystemPrompt}
                defaultValue={state.defaults.adhocSystemPrompt}
                onChange={(v) => field('adhocSystemPrompt', v)}
              />

              <div className="settings-field">
                <label className="settings-label">Permission mode</label>
                <div className="settings-help">
                  How claude handles permission prompts. <strong>acceptEdits</strong> still asks for non-edit
                  operations (routed to Telegram as buttons). <strong>bypassPermissions</strong> skips all
                  prompts — fast, but you lose the human-in-the-loop safety net.
                </div>
                <div className="settings-radio-group">
                  <label className="settings-radio">
                    <input
                      type="radio"
                      name="permissionMode"
                      value="acceptEdits"
                      checked={draft.permissionMode === 'acceptEdits'}
                      onChange={() => field('permissionMode', 'acceptEdits' as PermissionMode)}
                    />
                    <span>acceptEdits (recommended)</span>
                  </label>
                  <label className="settings-radio">
                    <input
                      type="radio"
                      name="permissionMode"
                      value="bypassPermissions"
                      checked={draft.permissionMode === 'bypassPermissions'}
                      onChange={() => field('permissionMode', 'bypassPermissions' as PermissionMode)}
                    />
                    <span>bypassPermissions (auto-trust)</span>
                  </label>
                </div>
              </div>

              <div className="settings-field">
                <label className="settings-label">Turn-end debounce (ms)</label>
                <div className="settings-help">
                  How long mother/adhoc must stay idle before scuba posts the "replied" screenshot to the
                  bound chat. Lower = snappier; higher = fewer premature fires while claude blinks between
                  tool calls. Default {state.defaults.turnEndDebounceMs}.
                </div>
                <input
                  type="number"
                  className="settings-number"
                  min={0}
                  step={100}
                  value={draft.turnEndDebounceMs}
                  onChange={(e) => field('turnEndDebounceMs', Number(e.target.value))}
                />
              </div>
            </div>

            <div className="settings-footer">
              <div className="settings-status">
                {saveError && <span className="settings-error">{saveError}</span>}
                {!saveError && savedAt && !dirty && <span className="settings-saved">Saved.</span>}
                {!saveError && dirty && <span className="settings-dirty">Unsaved changes</span>}
              </div>
              <div className="settings-actions">
                <button className="btn" onClick={onClose} disabled={saving}>
                  Close
                </button>
                <button className="btn btn-primary" onClick={save} disabled={saving || !dirty}>
                  {saving ? 'Saving…' : 'Save'}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

interface PromptFieldProps {
  label: string;
  help: string;
  value: string;
  defaultValue: string;
  onChange: (v: string) => void;
}

function PromptField({ label, help, value, defaultValue, onChange }: PromptFieldProps) {
  const isDefault = value === defaultValue;
  return (
    <div className="settings-field">
      <div className="settings-label-row">
        <label className="settings-label">{label}</label>
        <button
          type="button"
          className="settings-reset"
          onClick={() => onChange(defaultValue)}
          disabled={isDefault}
          title={isDefault ? 'Already at default' : 'Reset to default'}
        >
          Reset to default
        </button>
      </div>
      <div className="settings-help">{help}</div>
      <textarea
        className="settings-textarea"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={10}
        spellCheck={false}
      />
    </div>
  );
}
