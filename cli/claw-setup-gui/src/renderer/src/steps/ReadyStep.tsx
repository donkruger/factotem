import { useEffect, useState } from 'react'
import { Button } from '../components/Button'
import { CommandBlock } from '../components/CommandBlock'
import { Mascot } from '../components/Mascot'
import { useElectronAPI } from '../hooks/useElectronAPI'
import type { HealthSummary } from '@shared/types'

interface Props {
  onBack: () => void
}

type Phase = 'waiting' | 'ready' | 'timeout' | 'opening' | 'dashboard-missing'

// Wizard terminus. Polls /health until the orchestrator responds, then
// hands off to the Factotem dashboard *inside* the same Electron window
// (not the system browser). Boot-time skip-when-healthy uses the same
// path — once everything's installed the wizard becomes invisible and
// the user just sees the dashboard when they open the app.
export function ReadyStep({ onBack }: Props) {
  const api = useElectronAPI()
  const [phase, setPhase] = useState<Phase>('waiting')
  const [health, setHealth] = useState<HealthSummary | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!api) return
    void (async () => {
      const ready = await api.dashboard.waitForReady(30000)
      if (ready) {
        const h = await api.health.probe()
        setHealth(h)
        setPhase('ready')
      } else {
        setPhase('timeout')
      }
    })()
  }, [api])

  async function handleOpen() {
    if (!api) return
    setPhase('opening')
    setError(null)
    const r = await api.dashboard.open()
    if (!r.success) {
      setPhase('dashboard-missing')
      setError(r.error ?? 'Could not load the dashboard.')
      return
    }
    // On success the window navigates away to the dashboard URL — this
    // component unmounts. No app.quit, no shell.openExternal.
  }

  async function openExternalAnyway() {
    if (!api) return
    await api.dashboard.openExternal()
  }

  return (
    <div className="step-enter flex-1 flex flex-col items-center justify-center px-10 py-7 text-center relative z-10 max-w-2xl mx-auto w-full">
      <div className="mb-6">
        <Mascot
          state={
            phase === 'ready' || phase === 'opening'
              ? 'success'
              : phase === 'timeout' || phase === 'dashboard-missing'
                ? 'error'
                : 'loading'
          }
          size={120}
        />
      </div>

      {phase === 'waiting' && (
        <>
          <h2
            className="text-2xl mb-2"
            style={{
              color: 'var(--color-ink)',
              letterSpacing: 'var(--tracking-display)',
              fontWeight: 600
            }}
          >
            Bringing the dashboard up…
          </h2>
          <p
            className="text-sm max-w-md mx-auto"
            style={{ color: 'var(--color-ink-muted)', lineHeight: 1.55 }}
          >
            Waiting for the orchestrator&apos;s <code>/health</code> to respond.
            This usually takes a few seconds after the service starts.
          </p>
        </>
      )}

      {(phase === 'ready' || phase === 'opening') && (
        <>
          <h2
            className="text-2xl mb-2"
            style={{
              color: 'var(--color-ink)',
              letterSpacing: 'var(--tracking-display)',
              fontWeight: 600
            }}
          >
            Your assistant is online.
          </h2>
          <p
            className="text-sm mb-3 max-w-md mx-auto"
            style={{ color: 'var(--color-ink-muted)', lineHeight: 1.55 }}
          >
            The Factotem dashboard is the home for daily use — status, message
            activity, group management, and authentication live there. It
            opens here in this window.
          </p>

          {health && (
            <div
              className="text-xs mb-6 px-3 py-2 rounded-md inline-flex items-center gap-3"
              style={{
                color: 'var(--color-ink-muted)',
                background: 'var(--color-bg-elevated)',
                border: '1px solid var(--color-hairline)'
              }}
            >
              <span style={{ color: 'var(--color-success)' }}>●</span>
              <span>
                NanoClaw {health.nanoclaw.version ? `v${health.nanoclaw.version}` : 'running'}
                {health.nanoclaw.pid ? ` · pid ${health.nanoclaw.pid}` : ''}
                {health.docker.containers !== undefined
                  ? ` · ${health.docker.containers} container${health.docker.containers === 1 ? '' : 's'}`
                  : ''}
              </span>
            </div>
          )}

          <div className="flex items-center gap-3">
            <Button variant="ghost" onClick={onBack}>
              Back
            </Button>
            <Button
              variant="accent"
              size="lg"
              onClick={handleOpen}
              loading={phase === 'opening'}
            >
              Open dashboard
            </Button>
          </div>
          <p
            className="text-[10px] tracking-wider uppercase mt-4"
            style={{
              color: 'var(--color-ink-dim)',
              letterSpacing: 'var(--tracking-caption)'
            }}
          >
            Return to setup any time with <kbd>⌘ ⇧ W</kbd>
          </p>
        </>
      )}

      {phase === 'dashboard-missing' && (
        <>
          <h2
            className="text-2xl mb-2"
            style={{
              color: 'var(--color-ink)',
              letterSpacing: 'var(--tracking-display)',
              fontWeight: 600
            }}
          >
            The dashboard isn&apos;t built yet.
          </h2>
          <p
            className="text-sm mb-4 max-w-md mx-auto"
            style={{ color: 'var(--color-ink-muted)', lineHeight: 1.55 }}
          >
            The orchestrator is up, but no dashboard is being served on the
            usual ports. Build the static export once and the orchestrator
            will serve it from <code>:7842</code> from then on.
          </p>

          <CommandBlock
            command="cd ~/factotem/dashboard && npm install && npm run build && launchctl kickstart -k gui/$(id -u)/com.nanoclaw"
            caption="Run once in Terminal"
          />

          {error && (
            <p
              className="text-xs mt-3 max-w-md mx-auto"
              style={{ color: 'var(--color-ink-muted)' }}
            >
              {error}
            </p>
          )}

          <div className="flex items-center gap-3 mt-5">
            <Button variant="ghost" onClick={onBack}>
              Back
            </Button>
            <Button variant="ghost" onClick={openExternalAnyway}>
              Try external browser instead
            </Button>
            <Button onClick={handleOpen}>Retry</Button>
          </div>
        </>
      )}

      {phase === 'timeout' && (
        <>
          <h2
            className="text-2xl mb-2"
            style={{
              color: 'var(--color-ink)',
              letterSpacing: 'var(--tracking-display)',
              fontWeight: 600
            }}
          >
            <code>/health</code> didn&apos;t respond in 30 s.
          </h2>
          <p
            className="text-sm mb-5 max-w-md mx-auto"
            style={{ color: 'var(--color-ink-muted)', lineHeight: 1.55 }}
          >
            Step 09 installs the service. If the service is loaded but the
            process isn&apos;t healthy, check{' '}
            <code>~/factotem/.logs/nanoclaw.err.log</code> for a clue.
          </p>
          <div className="flex items-center gap-3">
            <Button variant="ghost" onClick={onBack}>
              Back
            </Button>
            <Button variant="accent" size="lg" onClick={handleOpen}>
              Try opening dashboard anyway
            </Button>
          </div>
        </>
      )}
    </div>
  )
}
