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
  dismissWelcome,
  getCurrentVersion,
  getLastStatus,
  openSetupInTerminal,
  type StackStatus,
} from '../lib/tauri';

// One-liner that an operator with source-repo access can paste into a
// fresh terminal: clones the repo, then runs the wizard via the
// orchestrator's top-level `npm run claw-setup` script (which handles
// the wizard's own install + build + run internally).
//
// Operators WITHOUT source-repo access need to ask their Factotem
// maintainer to grant them collaborator access on donkruger/factotem
// first — the wizard provisions the orchestrator from a clone of that
// (private) repo. Documented in the welcome copy below.
const SETUP_COMMAND =
  'gh repo clone donkruger/factotem && cd factotem && npm run claw-setup';

export function WelcomeView() {
  const [status, setStatus] = useState<StackStatus | null>(null);
  const [version, setVersion] = useState<string>('');
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'error'>('idle');
  const [terminalState, setTerminalState] = useState<'idle' | 'opening' | 'opened' | 'error'>(
    'idle',
  );
  const [terminalError, setTerminalError] = useState<string | null>(null);

  // Pull the latest probe snapshot to drive state A vs state B.
  // No subscription — the welcome window is short-lived and the
  // operator dismisses it before the next probe completes anyway.
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
    return () => {
      cancelled = true;
    };
  }, []);

  const isStackPresent =
    status?.overall && status.overall !== 'notinstalled' && status.overall !== 'grey';

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
            this machine. Setting one up requires <strong>source-repo access</strong>{' '}
            — the wizard provisions from a clone of <code>donkruger/factotem</code>{' '}
            (a private repo).
          </p>
          <p className="prereq">
            <strong>If you're a maintainer with access</strong>, run the
            wizard with this one-liner. It clones the repo and starts the
            cold-start wizard:
          </p>
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
            disabled={terminalState === 'opening' || terminalState === 'opened'}
          >
            {terminalState === 'opened'
              ? '✓ Opened — press Enter in Terminal'
              : terminalState === 'opening'
                ? 'Opening…'
                : 'Open Terminal with this command'}
          </button>
          {terminalError && (
            <p className="error">Could not open Terminal: {terminalError}</p>
          )}
          <p className="hint">
            Terminal.app opens with the command pre-staged. You press Enter
            to run it — the Doctor never executes setup commands without
            your explicit approval. Requires <code>gh</code> CLI installed
            and authenticated as a user with access to{' '}
            <code>donkruger/factotem</code>.
          </p>
          <p className="hint no-access">
            <strong>Don't have access yet?</strong> Contact your Factotem
            maintainer to be added as a collaborator on the source repo.
            The Doctor will keep running in your menu bar regardless — it
            shows "NanoClaw not installed" until a deployment exists on
            this machine.
          </p>
          <p className="docs-link">
            <a href="https://github.com/donkruger/factotem/blob/main/docs/SETUP_WIZARD.md" target="_blank" rel="noopener noreferrer">
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
      .hint.no-access {
        margin-top: 0.85rem;
        padding-top: 0.65rem;
        border-top: 1px solid var(--color-hairline);
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
    `}</style>
  );
}
