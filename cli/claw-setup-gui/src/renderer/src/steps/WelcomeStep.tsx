import { useEffect, useState } from 'react'
import { Button } from '../components/Button'
import { CommandBlock } from '../components/CommandBlock'
import { Mascot } from '../components/Mascot'
import { useElectronAPI } from '../hooks/useElectronAPI'

interface Props {
  onNext: () => void
}

type Availability =
  | { state: 'checking' }
  | { state: 'ok' }
  | { state: 'orchestrator-down' }
  | { state: 'dashboard-missing' }

// First-run welcome. Doubles as the "you're already set up" screen.
//
// On mount we ask the main process "can the operator skip to the
// dashboard right now?" via dashboard.availability(). Three outcomes:
//
//   ok                 → green banner with "Open dashboard" button
//   dashboard-missing  → amber banner with the build command (orchestrator
//                        is up but the static export isn't built yet)
//   orchestrator-down  → no banner; this is the genuine first-run case
//
// boot-time decideBoot() does the same check and auto-skips when ok,
// so this UI is mostly for the case where the user forced the wizard
// (NANOCLAW_FORCE_WIZARD=1) or only the orchestrator half is healthy.
export function WelcomeStep({ onNext }: Props) {
  const api = useElectronAPI()
  const [avail, setAvail] = useState<Availability>({ state: 'checking' })
  const [opening, setOpening] = useState(false)
  const [openError, setOpenError] = useState<string | null>(null)

  useEffect(() => {
    if (!api) return
    void (async () => {
      const r = await api.dashboard.availability()
      setAvail({ state: r.reason })
    })()
  }, [api])

  async function openDashboard() {
    if (!api) return
    setOpening(true)
    setOpenError(null)
    const r = await api.dashboard.open()
    if (!r.success) {
      setOpening(false)
      setOpenError(r.error ?? 'Could not load the dashboard.')
    }
  }

  return (
    <div className="step-enter flex-1 flex flex-col items-center justify-center px-10 text-center relative z-10">
      {avail.state === 'ok' && (
        <div
          className="panel-elevated mb-8 px-5 py-3 flex items-center gap-4 max-w-xl w-full text-left"
          style={{
            borderRadius: 'var(--radius-md)',
            border: `1px solid color-mix(in srgb, var(--color-accent) 35%, transparent)`
          }}
        >
          <span
            className="w-2 h-2 rounded-full flex-shrink-0"
            style={{ background: 'var(--color-success)' }}
          />
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium" style={{ color: 'var(--color-ink)' }}>
              NanoClaw is already running.
            </div>
            <div
              className="text-xs mt-0.5"
              style={{ color: 'var(--color-ink-muted)' }}
            >
              Skip setup and open the Factotem dashboard right away.
              {openError && (
                <>
                  {' '}
                  <span style={{ color: 'var(--color-error)' }}>{openError}</span>
                </>
              )}
            </div>
          </div>
          <Button
            variant="accent"
            size="sm"
            onClick={openDashboard}
            loading={opening}
          >
            Open dashboard
          </Button>
        </div>
      )}

      {avail.state === 'dashboard-missing' && (
        <div
          className="panel-elevated mb-8 px-5 py-4 max-w-xl w-full text-left"
          style={{
            borderRadius: 'var(--radius-md)',
            border: `1px solid color-mix(in srgb, var(--color-warning) 35%, transparent)`
          }}
        >
          <div className="flex items-center gap-3 mb-2">
            <span
              className="w-2 h-2 rounded-full flex-shrink-0"
              style={{ background: 'var(--color-warning)' }}
            />
            <div className="text-sm font-medium" style={{ color: 'var(--color-ink)' }}>
              Orchestrator is running, but the dashboard isn&apos;t built yet.
            </div>
          </div>
          <p
            className="text-xs mb-3"
            style={{ color: 'var(--color-ink-muted)', lineHeight: 1.55 }}
          >
            Build the static export once and the orchestrator will serve it
            from <code>:7842</code> from then on. After that, opening this app
            will land directly on the dashboard.
          </p>
          <CommandBlock command="cd ~/factotem/dashboard && npm install && npm run build && launchctl kickstart -k gui/$(id -u)/com.nanoclaw" />
        </div>
      )}

      <div className="mb-7">
        <Mascot state="idle" size={140} />
      </div>

      <h1
        className="wordmark text-5xl mb-2"
        style={{ color: 'var(--color-ink)' }}
      >
        NanoClaw
      </h1>
      <div
        className="h-[3px] w-12 mx-auto mb-5 rounded-full"
        style={{ background: 'var(--color-accent)' }}
      />

      <p
        className="text-base mb-1"
        style={{
          color: 'var(--color-ink)',
          letterSpacing: 'var(--tracking-tight)'
        }}
      >
        Your WhatsApp AI assistant, running on your own machine.
      </p>
      <p
        className="text-sm mb-9 max-w-md mx-auto"
        style={{
          color: 'var(--color-ink-muted)',
          lineHeight: 1.55
        }}
      >
        This wizard will set up the orchestrator, the OneCLI gateway, and
        the agent container — then pair WhatsApp and bring everything online.
        You can step out and resume any time.
      </p>

      <div className="flex flex-col items-center gap-3">
        <Button size="lg" onClick={onNext}>
          {avail.state === 'ok' || avail.state === 'dashboard-missing'
            ? 'Re-run setup anyway'
            : 'Begin setup'}
        </Button>
        <p
          className="text-xs"
          style={{
            color: 'var(--color-ink-dim)',
            letterSpacing: 'var(--tracking-caption)'
          }}
        >
          {avail.state === 'ok' || avail.state === 'dashboard-missing'
            ? 'Use this if you want to reconfigure something.'
            : 'Takes 10–15 minutes. Mostly waiting for downloads.'}
        </p>
      </div>
    </div>
  )
}
