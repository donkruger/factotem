import { useState } from 'react'
import { Button } from './Button'
import { CommandBlock } from './CommandBlock'
import {
  describeServiceError,
  ORCHESTRATOR_START_COMMAND
} from '../lib/serviceErrors'

interface Props {
  /** Resolved electronAPI (caller guarantees non-null). */
  api: NonNullable<Window['electronAPI']>
  /** Raw error string from the failed call, used to tailor the copy. */
  rawError?: string | null
  /** Called once the orchestrator is reachable again so the step can retry its load. */
  onResolved: () => void
  /**
   * Optional escape hatch for the dominant root cause: a logged-out
   * shared WhatsApp session makes the orchestrator exit before its HTTP
   * server binds, so "Start" never sticks. When provided, the panel
   * shows a "Re-pair WhatsApp" button that opens the WhatsApp QR journey
   * (which runs as a subprocess and does not need the orchestrator API).
   * The caller owns the navigation + any cleanup (e.g. stopping the
   * crash-looping service, clearing per-pairing context).
   */
  onRepairWhatsApp?: () => void | Promise<void>
}

// Reusable "the backend dependency is down" remediation panel.
//
// This is the canonical surface for the service-dependency remediation
// philosophy (see CLAUDE.md): rather than leak a raw "fetch failed",
// any step whose backend call hits a connection error renders this. It
// offers a one-click "Start the orchestrator" (launchctl kickstart via
// the service:start IPC), re-probes /health until the API answers, and
// falls back to a copy / Open-in-Terminal command block. If the start
// succeeds but health never comes up, it escalates to the most common
// real cause on a configured machine — a logged-out WhatsApp session,
// which makes the orchestrator exit before its HTTP server binds.
//
// `probeUntilReachable` is generous (≈30s) because a cold orchestrator
// ensures every per-group agent and connects WhatsApp before it binds
// :7842, so the API legitimately takes ~20–30s to answer after start.
export function OrchestratorUnreachable({
  api,
  rawError,
  onResolved,
  onRepairWhatsApp
}: Props) {
  // This panel only renders for the orchestrator-unreachable case, so
  // default to the connection description when no specific error string
  // was captured (e.g. a health-probe preflight with no thrown message).
  const info = describeServiceError(rawError ?? 'fetch failed')
  const [busy, setBusy] = useState<null | 'start' | 'retry' | 'repair'>(null)
  const [note, setNote] = useState<string | null>(null)

  async function probeUntilReachable(attempts = 12, delayMs = 2500): Promise<boolean> {
    for (let i = 0; i < attempts; i++) {
      const health = await api.health.probe()
      if (health.reachable) return true
      await new Promise((r) => setTimeout(r, delayMs))
    }
    return false
  }

  async function handleStart(): Promise<void> {
    setBusy('start')
    setNote(null)
    try {
      const started = await api.service.start()
      if (!started.success) {
        if (started.reason === 'not-installed') {
          setNote(
            'No NanoClaw service is installed on this machine yet. Finish the ' +
              'setup wizard (or run the orchestrator manually) before pairing.'
          )
        } else if (started.reason === 'unsupported') {
          setNote(
            'One-click start is macOS-only. Start the orchestrator manually ' +
              'with the command below, then choose Retry.'
          )
        } else {
          setNote(started.error ?? 'Could not start the orchestrator.')
        }
        return
      }
      const reachable = await probeUntilReachable()
      if (reachable) {
        onResolved()
        return
      }
      setNote(
        'The orchestrator was started but its API still isn’t answering. It ' +
          'may be exiting right after launch — a logged-out WhatsApp session ' +
          'does exactly this. Re-pair WhatsApp (or run `npm run claw-setup`), ' +
          'then choose Retry.'
      )
    } catch (err) {
      setNote((err as Error).message)
    } finally {
      setBusy(null)
    }
  }

  async function handleRetry(): Promise<void> {
    setBusy('retry')
    setNote(null)
    try {
      const health = await api.health.probe()
      if (health.reachable) {
        onResolved()
        return
      }
      setNote(
        'Still no response from the orchestrator. Try starting it, or check ' +
          'its logs at nanoclaw/logs/nanoclaw.error.log.'
      )
    } catch (err) {
      setNote((err as Error).message)
    } finally {
      setBusy(null)
    }
  }

  async function handleRepair(): Promise<void> {
    if (!onRepairWhatsApp) return
    setBusy('repair')
    setNote(null)
    try {
      await onRepairWhatsApp()
    } catch (err) {
      setNote((err as Error).message)
      setBusy(null)
    }
    // On success the caller navigates away from this step, so we
    // intentionally leave `busy` set to avoid a flash of re-enabled
    // buttons during the unmount.
  }

  return (
    <div
      className="panel px-5 py-4"
      style={{
        borderColor: 'var(--color-warning)',
        background: 'var(--color-warning-bg)'
      }}
    >
      <div
        className="text-sm font-medium mb-1"
        style={{ color: 'var(--color-ink)' }}
      >
        {info.title}
      </div>
      <p
        className="text-xs mb-3"
        style={{ color: 'var(--color-ink-muted)', lineHeight: 1.55 }}
      >
        {info.detail}
      </p>

      <div className="flex items-center gap-2.5 flex-wrap">
        <Button
          type="button"
          variant="primary"
          size="sm"
          onClick={handleStart}
          loading={busy === 'start'}
          disabled={busy !== null}
        >
          {busy === 'start' ? 'Starting…' : 'Start the orchestrator'}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={handleRetry}
          loading={busy === 'retry'}
          disabled={busy !== null}
        >
          Retry
        </Button>
        {onRepairWhatsApp && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={handleRepair}
            loading={busy === 'repair'}
            disabled={busy !== null}
          >
            Re-pair WhatsApp
          </Button>
        )}
      </div>

      {onRepairWhatsApp && (
        <p
          className="text-[11px] mt-2"
          style={{ color: 'var(--color-ink-muted)', lineHeight: 1.5 }}
        >
          Most often the orchestrator can&apos;t stay up because its shared
          WhatsApp session is logged out. <strong>Re-pair WhatsApp</strong> opens
          the QR journey (it doesn&apos;t need the API), then come back and
          choose Retry.
        </p>
      )}

      {busy === 'start' && (
        <p
          className="text-[11px] mt-2"
          style={{ color: 'var(--color-ink-muted)' }}
        >
          This can take up to ~30 seconds — the orchestrator initialises every
          agent before its API comes online.
        </p>
      )}

      {note && (
        <p
          className="text-xs mt-3"
          style={{ color: 'var(--color-ink)', lineHeight: 1.55 }}
        >
          {note}
        </p>
      )}

      <CommandBlock
        command={ORCHESTRATOR_START_COMMAND}
        caption="Or start it from a terminal"
      />
    </div>
  )
}
