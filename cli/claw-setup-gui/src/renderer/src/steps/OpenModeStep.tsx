import { useEffect, useState } from 'react'
import { Button } from '../components/Button'
import { useElectronAPI } from '../hooks/useElectronAPI'

interface Props {
  onNext: () => void
  onBack: () => void
}

type Phase = 'loading' | 'main-missing' | 'pick' | 'saving' | 'saved'

// Step 08 — Open-DM mode.
//
// Fully embedded: reads the main group from messages.db via the
// sqlite3 CLI, merges an `openMode` block into the group's
// container_config JSON, writes back, then SIGHUPs the orchestrator.
// No terminal handoff, no better-sqlite3 native module (which would
// have forced a per-platform electron-rebuild).
//
// The CLI step's behaviour is mirrored byte-for-byte: same JSON shape,
// same default rate limit (30/hr, burst 5), same SIGHUP-best-effort.
export function OpenModeStep({ onNext, onBack }: Props) {
  const api = useElectronAPI()
  const [orchestratorRoot, setOrchestratorRoot] = useState<string | null>(null)
  const [phase, setPhase] = useState<Phase>('loading')
  const [mainGroup, setMainGroup] = useState<{ jid: string; name: string } | null>(null)
  const [reason, setReason] = useState<string | null>(null)
  const [enabled, setEnabled] = useState(true)
  const [budgetCents, setBudgetCents] = useState(500)
  const [sighupSent, setSighupSent] = useState(false)
  const [appliedToName, setAppliedToName] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!api) return
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api])

  async function load() {
    if (!api) return
    setPhase('loading')
    setError(null)
    const env = await api.env.check()
    setOrchestratorRoot(env.orchestratorRoot)
    if (!env.orchestratorRoot) {
      setPhase('main-missing')
      setReason('NanoClaw checkout not detected.')
      return
    }
    const r = await api.openmode.readMain(env.orchestratorRoot)
    if (r.found) {
      setMainGroup({ jid: r.group.jid, name: r.group.name })
      // Restore any earlier preference from state.
      const s = await api.state.read()
      const cfg = s?.data['open_dm'] as
        | { enabled?: boolean; budgetCents?: number }
        | undefined
      if (cfg?.enabled !== undefined) setEnabled(cfg.enabled)
      if (cfg?.budgetCents !== undefined) setBudgetCents(cfg.budgetCents)
      setPhase('pick')
    } else {
      setReason(r.reason)
      setPhase('main-missing')
    }
  }

  async function apply() {
    if (!api || !orchestratorRoot) return
    setPhase('saving')
    setError(null)
    const r = await api.openmode.apply(orchestratorRoot, enabled, budgetCents)
    if (!r.success) {
      setError(r.error ?? 'Failed to apply open-DM config.')
      setPhase('pick')
      return
    }
    setSighupSent(r.sighup)
    setAppliedToName(r.appliedToName ?? null)
    await api.state.patch({
      data: {
        open_dm: { enabled, budgetCents, appliedToJid: r.appliedToJid }
      }
    })
    setPhase('saved')
  }

  return (
    <div className="step-enter flex-1 flex flex-col px-10 py-7 relative z-10 max-w-2xl mx-auto w-full">
      <div className="mb-5">
        <h2
          className="text-2xl mb-1"
          style={{
            color: 'var(--color-ink)',
            letterSpacing: 'var(--tracking-display)',
            fontWeight: 600
          }}
        >
          Open-DM mode
        </h2>
        <p
          className="text-sm"
          style={{ color: 'var(--color-ink-muted)', lineHeight: 1.55 }}
        >
          When enabled, the agent responds to direct messages without waiting
          for an @-mention. Per-sender containers with isolated memory get
          auto-onboarded on first contact. Daily budget caps cost exposure.
        </p>
      </div>

      {phase === 'loading' && (
        <div className="text-sm text-center py-8" style={{ color: 'var(--color-ink-muted)' }}>
          Reading main group from orchestrator&apos;s database…
        </div>
      )}

      {phase === 'main-missing' && (
        <div
          className="panel px-4 py-3 mb-5"
          style={{ borderRadius: 'var(--radius-md)' }}
        >
          <div className="flex items-start gap-3">
            <span
              className="w-2 h-2 rounded-full mt-2 flex-shrink-0"
              style={{ background: 'var(--color-warning)' }}
            />
            <div className="flex-1">
              <div className="text-sm font-medium" style={{ color: 'var(--color-ink)' }}>
                No main group registered
              </div>
              <div className="text-xs mt-1" style={{ color: 'var(--color-ink-muted)' }}>
                {reason ??
                  'Register a main WhatsApp group before configuring open-DM mode.'}
              </div>
              <div className="flex items-center gap-3 mt-3">
                <Button variant="ghost" size="sm" onClick={load}>
                  Retry
                </Button>
                <Button variant="ghost" size="sm" onClick={onBack}>
                  Back to register step
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {(phase === 'pick' || phase === 'saving') && mainGroup && (
        <>
          <div
            className="panel-elevated px-4 py-3 mb-5 flex items-center gap-3"
            style={{ borderRadius: 'var(--radius-md)' }}
          >
            <span
              className="w-2 h-2 rounded-full flex-shrink-0"
              style={{ background: 'var(--color-success)' }}
            />
            <div className="flex-1 min-w-0">
              <div className="text-xs" style={{ color: 'var(--color-ink-muted)' }}>
                Main group
              </div>
              <div
                className="text-sm font-medium truncate"
                style={{ color: 'var(--color-ink)' }}
                title={mainGroup.name}
              >
                {mainGroup.name}
              </div>
              <code
                className="text-xs"
                style={{ color: 'var(--color-ink-muted)' }}
              >
                {mainGroup.jid}
              </code>
            </div>
          </div>

          <label
            className="panel flex items-start gap-3 px-4 py-3 cursor-pointer mb-4"
            style={{ borderRadius: 'var(--radius-md)' }}
          >
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
              className="mt-0.5 accent-[color:var(--color-ink)]"
            />
            <div className="flex-1">
              <div className="text-sm font-medium" style={{ color: 'var(--color-ink)' }}>
                Enable open-DM mode (recommended)
              </div>
              <div className="text-xs mt-0.5" style={{ color: 'var(--color-ink-muted)' }}>
                Agent answers DMs without requiring an @-mention. Daily budget
                below caps cost exposure. Rate limit defaults to 30/hour, burst 5.
              </div>
            </div>
          </label>

          <div className="mb-5">
            <label
              className="block text-sm font-medium mb-1.5"
              style={{ color: 'var(--color-ink)' }}
              htmlFor="budget"
            >
              Daily budget cap (cents)
            </label>
            <input
              id="budget"
              type="number"
              min={50}
              max={50000}
              step={50}
              value={budgetCents}
              onChange={(e) => setBudgetCents(Number(e.target.value))}
              className="input-field font-mono"
              disabled={!enabled}
            />
            <div className="text-xs mt-1.5" style={{ color: 'var(--color-ink-muted)' }}>
              {(budgetCents / 100).toLocaleString('en-US', {
                style: 'currency',
                currency: 'USD'
              })}{' '}
              per day, refreshed at midnight in the orchestrator&apos;s timezone.
            </div>
          </div>

          {error && (
            <div
              className="text-sm mb-4 px-3 py-2 rounded-md"
              style={{ color: 'var(--color-error)', background: 'var(--color-error-bg)' }}
            >
              {error}
            </div>
          )}
        </>
      )}

      {phase === 'saved' && (
        <div
          className="panel px-4 py-3 mb-5"
          style={{ borderRadius: 'var(--radius-md)' }}
        >
          <div className="flex items-start gap-3">
            <span
              className="w-2 h-2 rounded-full mt-2 flex-shrink-0"
              style={{ background: 'var(--color-success)' }}
            />
            <div className="flex-1">
              <div className="text-sm font-medium" style={{ color: 'var(--color-ink)' }}>
                {enabled ? 'Open-DM enabled' : 'Open-DM left disabled'}
              </div>
              <div className="text-xs mt-1" style={{ color: 'var(--color-ink-muted)' }}>
                Applied to <strong>{appliedToName ?? 'the main group'}</strong>.{' '}
                {sighupSent ? (
                  <>
                    Orchestrator was hot-reloaded (<code>SIGHUP</code> sent) — new DMs
                    will be evaluated against the new config immediately.
                  </>
                ) : (
                  <>
                    Configuration written to SQLite, but the orchestrator wasn&apos;t
                    reachable for hot-reload. Restart the service to activate.
                  </>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="flex items-center justify-between gap-3 mt-auto pt-6">
        <Button variant="ghost" onClick={onBack} disabled={phase === 'saving'}>
          Back
        </Button>
        {phase === 'saved' ? (
          <Button onClick={onNext}>Continue</Button>
        ) : (
          <Button
            onClick={apply}
            loading={phase === 'saving'}
            disabled={phase !== 'pick'}
          >
            Apply to orchestrator
          </Button>
        )}
      </div>
    </div>
  )
}
