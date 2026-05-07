/**
 * Doctor Settings window — M1.4 of Phase 1.
 *
 * Operator preferences:
 *   - Probe interval (1–60s, default 5s) — how often the Doctor polls
 *     the stack. Tighter intervals catch transitions faster but add
 *     subprocess load (`docker info`, `launchctl list`, etc.).
 *   - Launch at login — registers the Doctor with macOS Login Items
 *     via `tauri-plugin-autostart`.
 *   - Notify on state change — fire a system notification whenever
 *     overall state transitions (green↔amber↔red).
 *   - Notify audibly — reserved; v2 plugin doesn't expose a clean
 *     "silent" flag, so this surfaces but doesn't yet take effect.
 *
 * Settings persist to
 * `~/Library/Application Support/Factotem/doctor-settings.json`.
 */
import { useCallback, useEffect, useState } from 'react';
import { getSettings, saveSettings, type Settings } from '../lib/tauri';

const POLL_MIN_MS = 1_000;
const POLL_MAX_MS = 60_000;

export function SettingsView() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getSettings()
      .then((s) => {
        if (!cancelled) setSettings(s);
      })
      .catch((e) => {
        if (!cancelled) setLoadError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const update = useCallback(<K extends keyof Settings>(key: K, value: Settings[K]) => {
    setSettings((prev) => (prev ? { ...prev, [key]: value } : prev));
    setSavedAt(null);
  }, []);

  const onSave = useCallback(async () => {
    if (!settings) return;
    const clamped = clampPoll(settings.poll_interval_ms);
    const payload: Settings = { ...settings, poll_interval_ms: clamped };
    setBusy(true);
    setSaveError(null);
    try {
      const persisted = await saveSettings(payload);
      setSettings(persisted);
      setSavedAt(Date.now());
    } catch (e) {
      setSaveError(String(e));
    } finally {
      setBusy(false);
    }
  }, [settings]);

  return (
    <div className="settings-shell">
      <Styles />
      <header>
        <span className="brand">
          <span className="dot" /> Factotem Doctor
        </span>
        <h1>Settings</h1>
        <p className="lede">
          Operator preferences. Probe interval and notification toggles
          take effect immediately; launch-at-login updates your macOS
          Login Items entry.
        </p>
      </header>

      {loadError && (
        <div className="banner error">
          Could not load settings: <code>{loadError}</code>
        </div>
      )}

      {settings && (
        <>
          <section className="section">
            <h2>Probe</h2>
            <div className="row">
              <label htmlFor="poll">Poll interval (seconds)</label>
              <input
                id="poll"
                type="number"
                min={POLL_MIN_MS / 1000}
                max={POLL_MAX_MS / 1000}
                step={1}
                value={Math.round(settings.poll_interval_ms / 1000)}
                onChange={(e) => {
                  const secs = Number(e.target.value);
                  if (Number.isFinite(secs)) {
                    update('poll_interval_ms', Math.round(secs * 1000));
                  }
                }}
                disabled={busy}
              />
            </div>
            <p className="hint">
              How often the Doctor checks Docker, OneCLI, NanoClaw, and
              port :7842. Default 5s. Range 1–60s.
            </p>
          </section>

          <section className="section">
            <h2>Startup</h2>
            <Toggle
              id="launch_at_login"
              label="Launch Doctor at login"
              hint="Registers the Doctor with macOS Login Items so it starts when you sign in."
              checked={settings.launch_at_login}
              onChange={(v) => update('launch_at_login', v)}
              disabled={busy}
            />
          </section>

          <section className="section">
            <h2>Notifications</h2>
            <Toggle
              id="notify_on_state_change"
              label="Notify on state change"
              hint="System notification when the stack flips between healthy / degraded / offline."
              checked={settings.notify_on_state_change}
              onChange={(v) => update('notify_on_state_change', v)}
              disabled={busy}
            />
            <Toggle
              id="notify_audible"
              label="Audible notifications"
              hint="Currently inherits the macOS default sound. A future build adds a true silent mode."
              checked={settings.notify_audible}
              onChange={(v) => update('notify_audible', v)}
              disabled={busy}
            />
          </section>

          <footer className="footer-bar">
            <div className="status">
              {saveError && (
                <span className="error" role="alert">
                  Save failed: {saveError}
                </span>
              )}
              {!saveError && savedAt && (
                <span className="ok" role="status">
                  Saved {timeAgo(savedAt)}
                </span>
              )}
            </div>
            <button
              type="button"
              className="primary"
              onClick={onSave}
              disabled={busy}
            >
              {busy ? 'Saving…' : 'Save changes'}
            </button>
          </footer>
        </>
      )}
    </div>
  );
}

function Toggle({
  id,
  label,
  hint,
  checked,
  onChange,
  disabled,
}: {
  id: string;
  label: string;
  hint: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className="toggle-row">
      <input
        id={id}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <div className="toggle-text">
        <label htmlFor={id}>{label}</label>
        <p className="hint">{hint}</p>
      </div>
    </div>
  );
}

function clampPoll(ms: number): number {
  if (!Number.isFinite(ms)) return 5_000;
  return Math.max(POLL_MIN_MS, Math.min(POLL_MAX_MS, Math.round(ms)));
}

function timeAgo(ts: number): string {
  const secs = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (secs < 5) return 'just now';
  if (secs < 60) return `${secs}s ago`;
  const m = Math.floor(secs / 60);
  return `${m}m ago`;
}

function Styles() {
  return (
    <style>{`
      .settings-shell {
        max-width: 480px;
        margin: 0 auto;
        padding: 1.75rem 1.25rem 2rem;
        color: var(--color-ink);
      }
      .settings-shell header { margin-bottom: 1.25rem; }
      .brand {
        display: inline-flex;
        align-items: center;
        gap: 0.5rem;
        font-size: 0.9rem;
        font-weight: 500;
      }
      .brand .dot {
        width: 0.55rem;
        height: 0.55rem;
        border-radius: 9999px;
        background: var(--color-accent);
      }
      h1 {
        font-size: 1.55rem;
        line-height: 1.2;
        letter-spacing: -0.015em;
        margin: 0.75rem 0 0.4rem;
        font-weight: 500;
      }
      .lede {
        color: var(--color-ink-muted);
        font-size: 0.85rem;
        margin: 0 0 1.25rem;
      }
      .banner {
        border-radius: 0.6rem;
        padding: 0.65rem 0.85rem;
        margin-bottom: 1rem;
        font-size: 0.85rem;
      }
      .banner.error {
        background: rgba(220, 50, 47, 0.08);
        color: #d33;
      }
      .banner code {
        font-family: var(--font-mono);
        font-size: 0.75rem;
      }

      .section {
        background: var(--color-bg-elevated);
        border: 1px solid var(--color-hairline);
        border-radius: var(--radius-2xl);
        padding: 1rem 1.1rem;
        margin-bottom: 0.9rem;
      }
      .section h2 {
        font-size: 0.78rem;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        color: var(--color-ink-muted);
        margin: 0 0 0.65rem;
        font-weight: 600;
      }
      .row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 1rem;
      }
      .row label {
        font-size: 0.9rem;
      }
      .row input[type="number"] {
        width: 5.5rem;
        text-align: right;
        background: var(--color-bg);
        color: var(--color-ink);
        border: 1px solid var(--color-hairline);
        border-radius: 0.5rem;
        padding: 0.4rem 0.6rem;
        font-size: 0.9rem;
      }
      .hint {
        margin: 0.4rem 0 0;
        font-size: 0.78rem;
        color: var(--color-ink-muted);
        line-height: 1.4;
      }
      .toggle-row {
        display: flex;
        align-items: flex-start;
        gap: 0.7rem;
        padding: 0.45rem 0;
      }
      .toggle-row + .toggle-row {
        border-top: 1px solid var(--color-hairline);
      }
      .toggle-row input[type="checkbox"] {
        margin-top: 0.2rem;
      }
      .toggle-text { flex: 1; }
      .toggle-text label {
        display: block;
        font-size: 0.9rem;
        font-weight: 500;
      }

      .footer-bar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-top: 1.1rem;
        gap: 0.85rem;
      }
      .status {
        font-size: 0.82rem;
        flex: 1;
        min-width: 0;
      }
      .status .error { color: #d33; }
      .status .ok { color: var(--color-ink-muted); }

      button.primary {
        background: var(--color-accent);
        color: white;
        border: none;
        border-radius: 9999px;
        padding: 0.55rem 1.4rem;
        font-size: 0.9rem;
        font-weight: 500;
        cursor: pointer;
        transition: filter 120ms ease;
      }
      button.primary:hover:not(:disabled) { filter: brightness(1.08); }
      button.primary:disabled {
        opacity: 0.55;
        cursor: not-allowed;
      }
    `}</style>
  );
}
