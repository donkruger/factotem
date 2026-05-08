/**
 * Repair Stack window — M1.3 of Phase 1.
 *
 * Renders the recovery-step manifest, gates execution on a typed-confirm
 * (`RESTART STACK`), then runs `start_repair` while subscribing to
 * `repair-progress` events for live UI updates per step.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  getRecoveryManifest,
  onRepairProgress,
  startRepair,
  type RecoveryManifest,
  type RecoveryStep,
  type RepairEvent,
  type RepairResult,
  type StepProgress,
  type StepState,
} from '../lib/tauri';

const CONFIRM_PHRASE = 'RESTART STACK';

export function RepairView() {
  const [manifest, setManifest] = useState<RecoveryManifest | null>(null);
  const [manifestError, setManifestError] = useState<string | null>(null);

  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<Record<string, StepState>>({});
  const [overall, setOverall] = useState<
    | { kind: 'idle' }
    | { kind: 'running' }
    | { kind: 'completed'; duration_ms: number }
    | { kind: 'failed'; failed_step_id: string; detail?: string }
  >({ kind: 'idle' });
  const [terminalError, setTerminalError] = useState<string | null>(null);

  // Load the manifest once on mount.
  useEffect(() => {
    let cancelled = false;
    getRecoveryManifest()
      .then((m) => {
        if (!cancelled) setManifest(m);
      })
      .catch((e) => {
        if (!cancelled) setManifestError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Subscribe to repair-progress events so the per-step state UI updates
  // live as the Rust backend executes the chain.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    onRepairProgress((evt) => handleEvent(evt))
      .then((fn) => {
        unlisten = fn;
      })
      .catch((e) => {
        console.error('repair-progress subscribe failed', e);
      });
    return () => {
      if (unlisten) unlisten();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleEvent = useCallback((evt: RepairEvent) => {
    setProgress((prev) => {
      const next = { ...prev };
      switch (evt.type) {
        case 'step_started':
          next[evt.step_id] = { kind: 'running' };
          break;
        case 'step_done':
          next[evt.step_id] = { kind: 'done', duration_ms: evt.duration_ms };
          break;
        case 'step_failed':
          next[evt.step_id] = {
            kind: 'failed',
            detail: evt.detail,
            duration_ms: evt.duration_ms,
          };
          break;
        case 'step_skipped':
          next[evt.step_id] = { kind: 'skipped', detail: evt.detail };
          break;
        default:
          break;
      }
      return next;
    });
    if (evt.type === 'completed') {
      setOverall({ kind: 'completed', duration_ms: evt.duration_ms });
    } else if (evt.type === 'failed') {
      setOverall((prev) =>
        prev.kind === 'failed'
          ? prev
          : { kind: 'failed', failed_step_id: evt.failed_step_id },
      );
    }
  }, []);

  const onRun = useCallback(async () => {
    if (confirm !== CONFIRM_PHRASE || busy) return;
    setBusy(true);
    setTerminalError(null);
    setOverall({ kind: 'running' });
    // Reset per-step state — we may be re-running.
    if (manifest) {
      const reset: Record<string, StepState> = {};
      for (const s of manifest.steps) reset[s.id] = { kind: 'pending' };
      setProgress(reset);
    }
    try {
      const result: RepairResult = await startRepair(confirm);
      // Reconcile per-step state from the synchronous result. Same defence
      // as PullView: a fast step (preflight-style failures, no-op verifies)
      // can race the Tauri listener subscription and leave badges stuck at
      // "Pending" while the overall result is correctly computed. The
      // RepairResult is authoritative final state by design (see
      // `src-tauri/src/repair.rs` module doc), so syncing it here makes the
      // per-step badges robust to event-delivery quirks.
      setProgress((prev) => {
        const next = { ...prev };
        for (const s of result.steps) {
          next[s.id] = s.state;
        }
        return next;
      });
      // The result's overall is authoritative (covers the race where
      // the final `completed` / `failed` event hasn't yet been
      // processed by the listener).
      if (result.overall.kind === 'completed') {
        setOverall({
          kind: 'completed',
          duration_ms: result.overall.duration_ms,
        });
      } else if (result.overall.kind === 'failed') {
        setOverall({
          kind: 'failed',
          failed_step_id: result.overall.failed_step_id,
        });
      }
    } catch (e) {
      setTerminalError(String(e));
      setOverall({ kind: 'idle' });
    } finally {
      setBusy(false);
    }
  }, [confirm, busy, manifest]);

  if (manifestError) {
    return (
      <div className="repair-shell">
        <div className="error-card">
          <h2>Recovery manifest failed to load</h2>
          <pre>{manifestError}</pre>
        </div>
      </div>
    );
  }

  if (!manifest) {
    return (
      <div className="repair-shell">
        <p className="muted">Loading recovery steps…</p>
      </div>
    );
  }

  const canRun = confirm === CONFIRM_PHRASE && !busy && overall.kind !== 'running';

  return (
    <div className="repair-shell">
      <header>
        <div className="brand">
          <span className="dot" aria-hidden="true" />
          <span>Factotem</span>
        </div>
        <h1>Repair Stack</h1>
        <p className="lede">
          Runs the four-step Docker → OneCLI → NanoClaw → verify recovery
          sequence. Each command is the same one in
          <code> docs/OPERATIONS.md § Recovery</code>; the Doctor just
          wraps them so you don&apos;t have to copy-paste.
        </p>
      </header>

      <ConfirmBar
        value={confirm}
        onChange={setConfirm}
        onRun={onRun}
        canRun={canRun}
        busy={busy}
      />

      {terminalError && (
        <div className="error-banner" role="alert">
          <strong>Could not start repair:</strong> {terminalError}
        </div>
      )}

      <ol className="steps">
        {manifest.steps.map((step) => (
          <StepRow
            key={step.id}
            step={step}
            state={progress[step.id] ?? { kind: 'pending' }}
          />
        ))}
      </ol>

      {overall.kind === 'completed' && (
        <SuccessFooter durationMs={overall.duration_ms} />
      )}
      {overall.kind === 'failed' && (
        <FailureFooter
          failedStepId={overall.failed_step_id}
          steps={manifest.steps}
          progress={progress}
        />
      )}

      <Styles />
    </div>
  );
}

function ConfirmBar({
  value,
  onChange,
  onRun,
  canRun,
  busy,
}: {
  value: string;
  onChange: (v: string) => void;
  onRun: () => void;
  canRun: boolean;
  busy: boolean;
}) {
  return (
    <section className="confirm-bar">
      <label htmlFor="confirm-input" className="confirm-label">
        Type <code>{CONFIRM_PHRASE}</code> to enable Run Repair
      </label>
      <div className="confirm-row">
        <input
          id="confirm-input"
          type="text"
          autoComplete="off"
          spellCheck={false}
          autoCapitalize="characters"
          value={value}
          onChange={(e) => onChange(e.target.value.toUpperCase())}
          placeholder={CONFIRM_PHRASE}
        />
        <button
          type="button"
          className="run-btn"
          onClick={onRun}
          disabled={!canRun}
        >
          {busy ? 'Running…' : 'Run Repair'}
        </button>
      </div>
    </section>
  );
}

function StepRow({
  step,
  state,
}: {
  step: RecoveryStep;
  state: StepState;
}) {
  const statusBadge = useMemo(() => {
    switch (state.kind) {
      case 'pending':
        return { label: 'Pending', cls: 'badge-pending' };
      case 'running':
        return { label: 'Running…', cls: 'badge-running' };
      case 'done':
        return {
          label: `Done (${formatDuration(state.duration_ms)})`,
          cls: 'badge-done',
        };
      case 'failed':
        return {
          label: `Failed (${formatDuration(state.duration_ms)})`,
          cls: 'badge-failed',
        };
      case 'skipped':
        return { label: 'Skipped', cls: 'badge-skipped' };
    }
  }, [state]);

  const hasDetail =
    (state.kind === 'failed' || state.kind === 'skipped') &&
    typeof state.detail === 'string';

  return (
    <li className={`step-row state-${state.kind}`}>
      <div className="step-head">
        <span className="step-title">{step.title}</span>
        <span className={`badge ${statusBadge.cls}`}>{statusBadge.label}</span>
      </div>
      <p className="step-why">{step.why}</p>
      <div className="step-cmd">
        <code>{step.command}</code>
      </div>
      {hasDetail && (
        <div className="step-detail">
          <summary>Detail</summary>
          <pre>{(state as { detail: string }).detail}</pre>
        </div>
      )}
    </li>
  );
}

function SuccessFooter({ durationMs }: { durationMs: number }) {
  return (
    <div className="footer success" role="status">
      <strong>Repair complete</strong>
      <span> in {formatDuration(durationMs)}</span>
      <p className="muted">
        The stack is back up. You can close this window. The tray icon
        should flip green within ~5 seconds.
      </p>
    </div>
  );
}

function FailureFooter({
  failedStepId,
  steps,
  progress,
}: {
  failedStepId: string;
  steps: RecoveryStep[];
  progress: Record<string, StepState>;
}) {
  const failed = steps.find((s) => s.id === failedStepId);
  const failedState = progress[failedStepId];
  const detail =
    failedState && failedState.kind === 'failed'
      ? failedState.detail
      : '(no detail)';
  return (
    <div className="footer failure" role="alert">
      <strong>Repair failed at: {failed?.title ?? failedStepId}</strong>
      <pre>{detail}</pre>
      <p className="muted">
        Inspect the Doctor&apos;s tray menu &amp; try the manual sequence
        in <code>docs/OPERATIONS.md § Recovery</code>. You can re-run
        Repair after fixing the issue.
      </p>
    </div>
  );
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rs = Math.round(s % 60);
  return `${m}m ${rs}s`;
}

// Inline component-scoped styles. Co-located so the Repair view is fully
// self-contained — easier to migrate this whole module into the
// long-term Electron Factotem app later as a single block.
function Styles() {
  return (
    <style>{`
      .repair-shell {
        max-width: 540px;
        margin: 0 auto;
        padding: 1.75rem 1.25rem 2.5rem;
      }
      .repair-shell header { margin-bottom: 1.25rem; }
      .brand {
        display: inline-flex;
        align-items: center;
        gap: 0.5rem;
        font-size: 0.95rem;
        font-weight: 500;
        color: var(--color-ink);
      }
      .brand .dot {
        width: 0.55rem;
        height: 0.55rem;
        border-radius: 9999px;
        background: var(--color-accent);
      }
      h1 {
        font-size: 1.65rem;
        line-height: 1.2;
        letter-spacing: -0.015em;
        margin: 0.85rem 0 0.4rem;
        font-weight: 500;
      }
      .lede {
        color: var(--color-ink-muted);
        font-size: 0.85rem;
        margin: 0 0 1rem;
      }
      .lede code {
        background: var(--color-bg-subtle);
        padding: 0.1rem 0.4rem;
        border-radius: 0.4rem;
        font-size: 0.78rem;
      }

      .confirm-bar {
        background: var(--color-bg-elevated);
        border: 1px solid var(--color-hairline);
        border-radius: var(--radius-2xl);
        padding: 0.95rem 1rem;
        margin-bottom: 1.25rem;
      }
      .confirm-label {
        display: block;
        color: var(--color-ink-muted);
        font-size: 0.78rem;
        margin-bottom: 0.5rem;
      }
      .confirm-label code {
        background: var(--color-bg-subtle);
        padding: 0.1rem 0.4rem;
        border-radius: 0.4rem;
        color: var(--color-ink);
        font-size: 0.75rem;
      }
      .confirm-row {
        display: flex;
        gap: 0.5rem;
      }
      .confirm-row input {
        flex: 1;
        background: var(--color-bg);
        color: var(--color-ink);
        border: 1px solid var(--color-hairline);
        border-radius: 0.6rem;
        padding: 0.5rem 0.85rem;
        font-family: var(--font-mono);
        font-size: 0.85rem;
        letter-spacing: 0.05em;
      }
      .confirm-row input:focus {
        outline: 2px solid var(--color-focus-ring);
        outline-offset: 1px;
      }
      .run-btn {
        background: var(--color-error);
        color: #fff;
        border: 1px solid var(--color-error);
        border-radius: var(--radius-pill);
        padding: 0.5rem 1.2rem;
        cursor: pointer;
        font-weight: 500;
        font-size: 0.85rem;
        transition: transform var(--duration-micro) var(--ease-apple),
          opacity var(--duration-micro) var(--ease-apple);
      }
      .run-btn:hover:not(:disabled) { transform: translateY(-1px); }
      .run-btn:disabled {
        opacity: 0.4;
        cursor: not-allowed;
      }

      .error-banner {
        background: rgba(248, 113, 113, 0.12);
        border: 1px solid rgba(248, 113, 113, 0.4);
        border-radius: var(--radius-xl);
        padding: 0.75rem 1rem;
        font-size: 0.85rem;
        margin-bottom: 1rem;
        color: var(--color-error);
      }

      .steps {
        list-style: none;
        padding: 0;
        margin: 0;
        display: flex;
        flex-direction: column;
        gap: 0.75rem;
      }
      .step-row {
        background: var(--color-bg-elevated);
        border: 1px solid var(--color-hairline);
        border-radius: var(--radius-2xl);
        padding: 0.95rem 1rem;
        transition: border-color var(--duration-state) var(--ease-apple);
      }
      .step-row.state-running { border-color: var(--color-warning); }
      .step-row.state-done { border-color: var(--color-success); }
      .step-row.state-failed { border-color: var(--color-error); }
      .step-row.state-skipped { opacity: 0.6; }

      .step-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 0.5rem;
      }
      .step-title { font-weight: 500; font-size: 0.95rem; }
      .badge {
        padding: 0.18rem 0.6rem;
        border-radius: var(--radius-pill);
        font-size: 0.7rem;
        font-weight: 500;
        white-space: nowrap;
      }
      .badge-pending {
        background: var(--color-bg-subtle);
        color: var(--color-ink-muted);
      }
      .badge-running {
        background: rgba(251, 191, 36, 0.18);
        color: var(--color-warning);
      }
      .badge-done {
        background: rgba(52, 211, 153, 0.18);
        color: var(--color-success);
      }
      .badge-failed {
        background: rgba(248, 113, 113, 0.18);
        color: var(--color-error);
      }
      .badge-skipped {
        background: var(--color-bg-subtle);
        color: var(--color-ink-muted);
      }

      .step-why {
        margin: 0.45rem 0 0.6rem;
        color: var(--color-ink-muted);
        font-size: 0.8rem;
      }
      .step-cmd {
        background: var(--color-bg-subtle);
        border: 1px solid var(--color-hairline);
        border-radius: 0.55rem;
        padding: 0.45rem 0.7rem;
        overflow-x: auto;
      }
      .step-cmd code {
        font-size: 0.78rem;
        white-space: nowrap;
      }
      .step-detail {
        margin-top: 0.5rem;
        font-size: 0.78rem;
      }
      .step-detail pre {
        background: var(--color-bg-subtle);
        border: 1px solid var(--color-hairline);
        border-radius: 0.55rem;
        padding: 0.5rem 0.7rem;
        margin: 0.4rem 0 0;
        white-space: pre-wrap;
        word-break: break-word;
        max-height: 180px;
        overflow-y: auto;
        color: var(--color-error);
      }

      .footer {
        margin-top: 1.5rem;
        padding: 1rem;
        border-radius: var(--radius-2xl);
        border: 1px solid var(--color-hairline);
      }
      .footer.success {
        background: rgba(52, 211, 153, 0.08);
        border-color: rgba(52, 211, 153, 0.4);
      }
      .footer.failure {
        background: rgba(248, 113, 113, 0.08);
        border-color: rgba(248, 113, 113, 0.4);
      }
      .footer p { margin: 0.5rem 0 0; }
      .footer pre {
        background: var(--color-bg-subtle);
        border: 1px solid var(--color-hairline);
        border-radius: 0.55rem;
        padding: 0.5rem 0.7rem;
        margin: 0.5rem 0;
        white-space: pre-wrap;
        word-break: break-word;
        font-size: 0.78rem;
      }

      .muted { color: var(--color-ink-muted); font-size: 0.8rem; }
      .error-card {
        margin: 2rem auto;
        max-width: 480px;
        background: rgba(248, 113, 113, 0.08);
        border: 1px solid rgba(248, 113, 113, 0.4);
        border-radius: var(--radius-2xl);
        padding: 1.25rem;
      }
      .error-card pre {
        background: var(--color-bg-subtle);
        padding: 0.5rem 0.75rem;
        border-radius: 0.55rem;
        white-space: pre-wrap;
        word-break: break-word;
        font-size: 0.78rem;
      }
    `}</style>
  );
}
