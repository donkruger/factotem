/**
 * Welcome window — R.7 of Phase 2.
 *
 * Auto-opened on first launch (when settings.first_run_completed is
 * false) AND on demand from the tray's "Set up NanoClaw…" menu item
 * (visible only in the NotInstalled probe state).
 *
 * Two display states driven by the live probe:
 *   A. Stack detected — orient the operator to the menu-bar icon.
 *   B. Stack not installed — show the `npx claw-setup` setup CTA.
 *
 * The "Got it" CTA writes first_run_completed = true via dismiss_welcome
 * so the welcome doesn't auto-open on subsequent launches.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  checkAllPrereqs,
  dismissWelcome,
  getCurrentVersion,
  getLastStatus,
  launchDockerAndWait,
  openSetupInTerminal,
  type PrereqResult,
  type StackStatus,
} from '../lib/tauri';

// R2 from the 2026-05-08 setup-journey UX audit
// (../../assessments/2026-05-08-setup-journey-ux.md): single curl-bootstrap
// idiom (oh-my-zsh / nvm / rustup shape) instead of the previous
// multi-line `git clone && cd && npm` chain. Half the length, mental
// shape the operator may have seen before, and the script itself
// (nanoclaw/scripts/bootstrap.sh) handles git/node preflight with
// actionable hints, TCC-safe target dir ($HOME/factotem), and a clean
// exec into the wizard.
//
// The bootstrap.sh URL is the same stable-redirect shape that
// install-doctor.sh already uses for the Doctor .dmg (see
// scripts/install-doctor.sh line 168).
//
// Real prerequisites on a fresh macOS:
//   - curl (always present)
//   - git (Xcode Command Line Tools — auto-prompts on first invocation;
//     bootstrap.sh detects + tells the operator)
//   - Node.js 20+ (operator must install — bootstrap.sh detects + tells
//     the operator with the nodejs.org link)
//
// Everything else (Docker, OneCLI, Tailscale, the agent container,
// the launchd plist) is handled by the wizard once it starts.
const SETUP_COMMAND =
  'curl -fsSL https://github.com/RichardBNel/Factotem/releases/latest/download/bootstrap.sh | sh';

export function WelcomeView() {
  const [status, setStatus] = useState<StackStatus | null>(null);
  const [version, setVersion] = useState<string>('');
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'error'>('idle');
  const [terminalState, setTerminalState] = useState<'idle' | 'opening' | 'opened' | 'error'>(
    'idle',
  );
  const [terminalError, setTerminalError] = useState<string | null>(null);

  // R1 — pre-flight prereq probe state.
  // null while the first probe is in flight; [] is impossible (the
  // backend always returns four entries). `prereqsLoading` covers
  // both the initial mount load and the Recheck button.
  const [prereqs, setPrereqs] = useState<PrereqResult[] | null>(null);
  const [prereqsLoading, setPrereqsLoading] = useState<boolean>(true);
  const [dockerLaunching, setDockerLaunching] = useState<boolean>(false);

  const refreshPrereqs = useCallback(async () => {
    setPrereqsLoading(true);
    try {
      const results = await checkAllPrereqs();
      setPrereqs(results);
    } catch {
      // Backend error — leave prereqs as-is and let operator try again
      // via the Recheck button. We don't surface the raw error because
      // the per-row `detail` string is the operator-facing message.
    } finally {
      setPrereqsLoading(false);
    }
  }, []);

  // Pull the latest probe snapshot to drive state A vs state B,
  // and run the prereq probes once on mount.
  useEffect(() => {
    let cancelled = false;
    getLastStatus()
      .then((s) => {
        if (!cancelled) setStatus(s);
      })
      .catch(() => {});
    getCurrentVersion()
      .then((v) => {
        if (!cancelled) setVersion(v);
      })
      .catch(() => {});
    void refreshPrereqs();
    return () => {
      cancelled = true;
    };
  }, [refreshPrereqs]);

  const isStackPresent =
    status?.overall && status.overall !== 'notinstalled' && status.overall !== 'grey';

  // R1 gate: only the two non-wizard prereqs (git, node) block the
  // CTA — Docker / Tailscale are wizard-handled (Docker auto-launches
  // via R3, Tailscale install is part of step 02). This keeps the
  // gate strict on what would actually fail Terminal-side ("command
  // not found: npm"), without requiring the operator to install
  // tailscale before they've even started.
  const blockingPrereqs = (prereqs ?? []).filter(
    (p) => p.name === 'git' || p.name === 'node',
  );
  const blockingReady =
    blockingPrereqs.length > 0 && blockingPrereqs.every((p) => p.ok);

  const onCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(SETUP_COMMAND);
      setCopyState('copied');
      window.setTimeout(() => setCopyState('idle'), 2_000);
    } catch {
      setCopyState('error');
      window.setTimeout(() => setCopyState('idle'), 3_000);
    }
  }, []);

  const onOpenTerminal = useCallback(async () => {
    setTerminalState('opening');
    setTerminalError(null);
    try {
      await openSetupInTerminal();
      setTerminalState('opened');
    } catch (e) {
      setTerminalState('error');
      setTerminalError(String(e));
    }
  }, []);

  const onLaunchDocker = useCallback(async () => {
    setDockerLaunching(true);
    try {
      await launchDockerAndWait();
      // Refresh the full list so the operator sees Docker flip to OK
      // (and any other state changes that happened during the wait).
      await refreshPrereqs();
    } catch {
      // best-effort — refresh anyway so the row reflects current state
      await refreshPrereqs();
    } finally {
      setDockerLaunching(false);
    }
  }, [refreshPrereqs]);

  const onDismiss = useCallback(async () => {
    try {
      await dismissWelcome();
    } catch {
      // best-effort — dismiss UI even if persistence fails
    }
    // Close the window. Tauri's hide() is enough; main.tsx's
    // CloseRequested handler intercepts and prevents close, but we
    // can use window.close() to bypass and actually close the window
    // since this one shouldn't reopen automatically.
    if (typeof window !== 'undefined') {
      const closeFn = (window as { __TAURI_CURRENT_WINDOW__?: { close: () => void } })
        .__TAURI_CURRENT_WINDOW__?.close;
      if (typeof closeFn === 'function') {
        closeFn();
      } else {
        // Fallback: try the standard close().
        window.close();
      }
    }
  }, []);

  return (
    <div className="welcome-shell">
      <Styles />
      <header>
        <span className="brand">
          <span className="dot" /> Factotem Doctor
        </span>
        {version && <span className="version">v{version}</span>}
      </header>

      <h1>Welcome.</h1>
      <p className="lede">
        The Factotem Doctor lives in your menu bar. Click the <strong>F</strong>{' '}
        icon up there for live health, repair, settings, and logs.
      </p>

      <div className="menu-bar-hint" aria-hidden>
        <span className="hint-arrow">↑</span>
        <span className="hint-label">Look in your menu bar</span>
      </div>

      {isStackPresent ? (
        <section className="state-card detected">
          <h2>NanoClaw deployment detected</h2>
          <p>
            Your stack is up and running. The Doctor will keep an eye on
            Docker, OneCLI, and NanoClaw every 5 seconds and alert you on
            state changes. You're all set.
          </p>
        </section>
      ) : (
        <section className="state-card setup">
          <h2>You don't have NanoClaw set up yet</h2>
          <p>
            The Factotem Doctor monitors a NanoClaw orchestrator running on
            this machine. Before you start the cold-start wizard we'll
            check the two things it can't auto-install for you:
          </p>

          <PrereqChecklist
            prereqs={prereqs}
            loading={prereqsLoading}
            dockerLaunching={dockerLaunching}
            onRecheck={refreshPrereqs}
            onLaunchDocker={onLaunchDocker}
          />

          <div className="cmd-row">
            <code className="cmd">{SETUP_COMMAND}</code>
            <button
              type="button"
              className="ghost compact"
              onClick={onCopy}
              title="Copy command to clipboard"
            >
              {copyState === 'copied' ? '✓ Copied' : copyState === 'error' ? '✗ Error' : 'Copy'}
            </button>
          </div>
          <button
            type="button"
            className="primary terminal-button"
            onClick={onOpenTerminal}
            disabled={
              terminalState === 'opening' ||
              terminalState === 'opened' ||
              !blockingReady
            }
            title={
              !blockingReady
                ? 'Install the missing prerequisites above first'
                : undefined
            }
          >
            {terminalState === 'opened'
              ? '✓ Opened — press Enter in Terminal'
              : terminalState === 'opening'
                ? 'Opening…'
                : !blockingReady
                  ? 'Open Terminal — fix prerequisites above first'
                  : 'Open Terminal with this command'}
          </button>
          {terminalError && (
            <p className="error">Could not open Terminal: {terminalError}</p>
          )}
          <p className="hint">
            Terminal.app opens with the command pre-staged. You press
            Enter to run it — the Doctor never executes setup commands
            without your explicit approval. Docker, Tailscale, OneCLI,
            and the agent container are all handled by the wizard once
            it starts.
          </p>
          <p className="docs-link">
            <a
              href="https://github.com/donkruger/factotem/blob/main/docs/SETUP_WIZARD.md"
              target="_blank"
              rel="noopener noreferrer"
            >
              Read the setup wizard documentation →
            </a>
          </p>
        </section>
      )}

      <footer>
        <button type="button" className="primary dismiss" onClick={onDismiss}>
          Got it
        </button>
      </footer>
    </div>
  );
}

// R1 — pre-flight prereq checklist. Renders four rows (git, node,
// docker, tailscale) with a per-row install link and, where applicable,
// a one-click Doctor-side fix (Launch Docker). The CTA above is gated
// on the two non-wizard prereqs (git, node) — Docker / Tailscale are
// shown for transparency but the wizard handles them itself.
function PrereqChecklist({
  prereqs,
  loading,
  dockerLaunching,
  onRecheck,
  onLaunchDocker,
}: {
  prereqs: PrereqResult[] | null;
  loading: boolean;
  dockerLaunching: boolean;
  onRecheck: () => Promise<void>;
  onLaunchDocker: () => Promise<void>;
}) {
  if (prereqs === null) {
    return (
      <div className="prereqs-card">
        <p className="prereqs-loading">Checking your machine…</p>
      </div>
    );
  }
  return (
    <div className="prereqs-card">
      <div className="prereqs-header">
        <span className="prereqs-title">Pre-flight check</span>
        <button
          type="button"
          className="ghost compact"
          onClick={() => {
            void onRecheck();
          }}
          disabled={loading}
          title="Re-run all four probes"
        >
          {loading ? 'Rechecking…' : 'Recheck'}
        </button>
      </div>
      <ul className="prereqs-list">
        {prereqs.map((p) => (
          <PrereqRow
            key={p.name}
            prereq={p}
            dockerLaunching={dockerLaunching}
            onLaunchDocker={onLaunchDocker}
          />
        ))}
      </ul>
    </div>
  );
}

function PrereqRow({
  prereq,
  dockerLaunching,
  onLaunchDocker,
}: {
  prereq: PrereqResult;
  dockerLaunching: boolean;
  onLaunchDocker: () => Promise<void>;
}) {
  const isBlocking = prereq.name === 'git' || prereq.name === 'node';
  const statusGlyph = prereq.ok ? '✓' : isBlocking ? '✗' : '⚠';
  const statusClass = prereq.ok
    ? 'prereq-ok'
    : isBlocking
      ? 'prereq-blocking'
      : 'prereq-warning';

  return (
    <li className={`prereq-row ${statusClass}`}>
      <span className="prereq-glyph" aria-hidden>
        {statusGlyph}
      </span>
      <div className="prereq-body">
        <div className="prereq-name">
          {labelFor(prereq.name)}
          {!isBlocking && !prereq.ok && (
            <span className="prereq-note"> · wizard will handle this</span>
          )}
        </div>
        <div className="prereq-detail">{prereq.detail}</div>
        {!prereq.ok && (
          <div className="prereq-actions">
            {prereq.fix_action?.kind === 'launch_docker_app' && (
              <button
                type="button"
                className="primary compact"
                onClick={() => {
                  void onLaunchDocker();
                }}
                disabled={dockerLaunching}
              >
                {dockerLaunching ? 'Launching Docker (up to 60s)…' : 'Launch Docker'}
              </button>
            )}
            <a
              className="prereq-link"
              href={prereq.install_url}
              target="_blank"
              rel="noopener noreferrer"
            >
              Install instructions ↗
            </a>
          </div>
        )}
      </div>
    </li>
  );
}

function labelFor(name: string): string {
  switch (name) {
    case 'git':
      return 'git';
    case 'node':
      return 'Node.js (≥ v20)';
    case 'docker':
      return 'Docker Desktop';
    case 'tailscale':
      return 'Tailscale';
    default:
      return name;
  }
}

function Styles() {
  return (
    <style>{`
      .welcome-shell {
        max-width: 540px;
        margin: 0 auto;
        padding: 1.75rem 1.5rem 1.5rem;
        color: var(--color-ink);
      }
      .welcome-shell header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 1rem;
      }
      .brand {
        display: inline-flex;
        align-items: center;
        gap: 0.5rem;
        font-size: 0.92rem;
        font-weight: 500;
      }
      .brand .dot {
        width: 0.55rem;
        height: 0.55rem;
        border-radius: 9999px;
        background: var(--color-accent);
      }
      .version {
        font-size: 0.78rem;
        color: var(--color-ink-muted);
        font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
      }

      h1 {
        font-size: 1.85rem;
        line-height: 1.15;
        letter-spacing: -0.02em;
        margin: 0 0 0.6rem;
        font-weight: 500;
      }
      .lede {
        color: var(--color-ink-muted);
        font-size: 0.92rem;
        line-height: 1.55;
        margin: 0 0 1.4rem;
      }
      .lede strong {
        color: var(--color-ink);
      }

      .menu-bar-hint {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        background: var(--color-bg-elevated);
        border: 1px dashed var(--color-hairline);
        border-radius: 0.75rem;
        padding: 0.6rem 0.9rem;
        margin: 0 0 1.5rem;
        font-size: 0.85rem;
        color: var(--color-ink-muted);
      }
      .hint-arrow {
        font-size: 1.4rem;
        color: var(--color-accent);
        font-weight: 700;
        animation: bob 1.6s ease-in-out infinite;
      }
      @keyframes bob {
        0%, 100% { transform: translateY(0); }
        50%      { transform: translateY(-3px); }
      }

      .state-card {
        border: 1px solid var(--color-hairline);
        border-radius: var(--radius-2xl);
        padding: 1rem 1.1rem 1.1rem;
        margin: 0 0 1.25rem;
        background: var(--color-bg-elevated);
      }
      .state-card.detected {
        border-color: rgba(52, 199, 89, 0.4);
      }
      .state-card.setup {
        border-color: var(--color-accent);
      }
      .state-card h2 {
        font-size: 0.78rem;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        color: var(--color-accent);
        margin: 0 0 0.55rem;
        font-weight: 600;
      }
      .state-card.detected h2 { color: rgb(40, 160, 70); }
      .state-card p {
        margin: 0 0 0.7rem;
        font-size: 0.88rem;
        line-height: 1.5;
      }

      .cmd-row {
        display: flex;
        align-items: center;
        gap: 0.55rem;
        margin: 0.7rem 0 0.85rem;
      }
      .cmd {
        flex: 1;
        background: var(--color-bg);
        border: 1px solid var(--color-hairline);
        border-radius: 0.55rem;
        padding: 0.6rem 0.85rem;
        font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
        font-size: 0.92rem;
        color: var(--color-ink);
        user-select: all;
      }

      .terminal-button {
        width: 100%;
        margin-bottom: 0.4rem;
      }

      .hint {
        margin: 0.55rem 0 0;
        font-size: 0.78rem;
        color: var(--color-ink-muted);
        line-height: 1.5;
      }
      .hint code {
        background: var(--color-bg-subtle);
        padding: 0.05rem 0.3rem;
        border-radius: 0.3rem;
        font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
        font-size: 0.72rem;
      }
      .hint.prereqs {
        margin-top: 0.85rem;
        padding-top: 0.65rem;
        border-top: 1px solid var(--color-hairline);
        line-height: 1.7;
      }
      .hint.prereqs a {
        color: var(--color-accent);
        text-decoration: none;
      }
      .hint.prereqs a:hover {
        text-decoration: underline;
      }
      .hint.prereqs em {
        font-style: italic;
        color: var(--color-ink);
      }
      .prereq {
        margin: 0.85rem 0 0.5rem;
        font-size: 0.88rem;
        color: var(--color-ink);
      }
      .state-card.setup p code {
        background: var(--color-bg-subtle);
        padding: 0.05rem 0.35rem;
        border-radius: 0.35rem;
        font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
        font-size: 0.78rem;
      }
      .docs-link {
        margin: 0.7rem 0 0;
        font-size: 0.85rem;
      }
      .docs-link a {
        color: var(--color-accent);
        text-decoration: none;
      }
      .docs-link a:hover {
        text-decoration: underline;
      }

      .error {
        margin: 0.45rem 0 0;
        font-size: 0.82rem;
        color: #d33;
      }

      footer {
        display: flex;
        justify-content: flex-end;
        margin-top: 0.5rem;
      }

      button.primary {
        background: var(--color-accent);
        color: white;
        border: none;
        border-radius: 9999px;
        padding: 0.6rem 1.5rem;
        font-size: 0.92rem;
        font-weight: 500;
        cursor: pointer;
        transition: filter 120ms ease;
      }
      button.primary:hover:not(:disabled) { filter: brightness(1.08); }
      button.primary:disabled {
        opacity: 0.55;
        cursor: not-allowed;
      }
      button.primary.dismiss {
        padding: 0.55rem 1.6rem;
      }
      button.ghost {
        background: var(--color-bg);
        color: var(--color-ink);
        border: 1px solid var(--color-hairline);
        border-radius: 9999px;
        padding: 0.45rem 0.95rem;
        font-size: 0.85rem;
        font-weight: 500;
        cursor: pointer;
      }
      button.ghost:hover:not(:disabled) {
        background: var(--color-bg-subtle);
      }
      button.compact {
        padding: 0.42rem 0.85rem;
        font-size: 0.82rem;
      }

      /* R1 — pre-flight prereq checklist */
      .prereqs-card {
        border: 1px solid var(--color-hairline);
        border-radius: 0.85rem;
        padding: 0.7rem 0.85rem 0.4rem;
        margin: 0.5rem 0 1rem;
        background: var(--color-bg);
      }
      .prereqs-loading {
        margin: 0;
        font-size: 0.85rem;
        color: var(--color-ink-muted);
      }
      .prereqs-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 0.35rem;
      }
      .prereqs-title {
        font-size: 0.75rem;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--color-ink-muted);
        font-weight: 600;
      }
      .prereqs-list {
        list-style: none;
        margin: 0;
        padding: 0;
      }
      .prereq-row {
        display: flex;
        align-items: flex-start;
        gap: 0.55rem;
        padding: 0.5rem 0;
        border-top: 1px solid var(--color-hairline);
      }
      .prereq-row:first-of-type {
        border-top: none;
      }
      .prereq-glyph {
        width: 1.1rem;
        height: 1.1rem;
        line-height: 1.1rem;
        text-align: center;
        font-weight: 700;
        font-size: 0.85rem;
        flex-shrink: 0;
        margin-top: 0.05rem;
      }
      .prereq-row.prereq-ok .prereq-glyph {
        color: rgb(40, 160, 70);
      }
      .prereq-row.prereq-blocking .prereq-glyph {
        color: #d33;
      }
      .prereq-row.prereq-warning .prereq-glyph {
        color: #c98a00;
      }
      .prereq-body {
        flex: 1;
        min-width: 0;
      }
      .prereq-name {
        font-size: 0.88rem;
        font-weight: 500;
        color: var(--color-ink);
      }
      .prereq-note {
        font-weight: 400;
        color: var(--color-ink-muted);
        font-size: 0.78rem;
      }
      .prereq-detail {
        font-size: 0.78rem;
        color: var(--color-ink-muted);
        line-height: 1.4;
        margin-top: 0.1rem;
      }
      .prereq-actions {
        display: flex;
        align-items: center;
        gap: 0.6rem;
        flex-wrap: wrap;
        margin-top: 0.4rem;
      }
      .prereq-link {
        font-size: 0.78rem;
        color: var(--color-accent);
        text-decoration: none;
      }
      .prereq-link:hover {
        text-decoration: underline;
      }
    `}</style>
  );
}
