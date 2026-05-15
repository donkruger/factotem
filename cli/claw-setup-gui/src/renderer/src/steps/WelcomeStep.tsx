import { useEffect, useState } from 'react'
import { Button } from '../components/Button'
import { CommandBlock } from '../components/CommandBlock'
import { HeroDisk } from '../components/HeroDisk'
import { useElectronAPI } from '../hooks/useElectronAPI'
import type { StepId } from '../hooks/useWizard'

interface Props {
  onNext: () => void
  /** Optional: jump directly to a non-default step. Used by the
   *  "Add another agent" affordance to land on `provider` and skip
   *  envCheck/install/etc. */
  onJump?: (stepId: StepId) => void
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
export function WelcomeStep({ onNext, onJump }: Props) {
  const api = useElectronAPI()
  const [avail, setAvail] = useState<Availability>({ state: 'checking' })
  const [opening, setOpening] = useState(false)
  const [openError, setOpenError] = useState<string | null>(null)
  const [existingAgents, setExistingAgents] = useState<
    Array<{ id: string; name: string; provider: { protocol: string } }> | null
  >(null)

  useEffect(() => {
    if (!api) return
    void (async () => {
      const r = await api.dashboard.availability()
      setAvail({ state: r.reason })
      // Read setup-state so we know whether to surface "Add another
      // agent" alongside "Reconfigure" — Phase H.5 of the Gemini
      // blueprint. If there's no state yet, this is a first-time
      // install and the standard "Begin setup" path applies.
      try {
        const state = await api.state.read()
        if (state && state.agents.length >= 1) {
          setExistingAgents(
            state.agents.map((a) => ({
              id: a.id,
              name: a.name,
              provider: { protocol: a.provider.protocol }
            }))
          )
        }
      } catch {
        /* state file unreadable — treat as first-time install */
      }
    })()
  }, [api])

  async function addAnotherAgent() {
    if (!api) return
    // Drop a hint in setup-state.data that ProviderStep + CredentialsStep
    // read to know they're creating a *new* agent, not reconfiguring the
    // default. The flag is cleared once the new agent lands in agents[].
    const state = await api.state.read()
    if (state) {
      await api.state.patch({
        data: { ...state.data, __mode: 'add-agent' }
      })
    }
    if (onJump) onJump('provider')
  }

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
    <div className="step-enter flex-1 flex flex-col items-center justify-safe-center px-10 py-8 text-center relative z-10">
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

      {/* Animated brand-mark disk (Three.js orb + grass-blade ring,
          ported from the Factotem marketing site). 240 px slot —
          ≈33 % larger than the previous 180 px sizing, so the ring
          detail reads comfortably and the hover scale has somewhere
          to grow into. */}
      <div className="mb-7">
        <HeroDisk size={240} />
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
        className="text-sm mb-2 max-w-md mx-auto"
        style={{
          color: 'var(--color-ink-muted)',
          lineHeight: 1.55
        }}
      >
        Powered by Claude by default — switchable to Gemini, OpenAI, or
        local models any time from the dashboard.
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
        {existingAgents && existingAgents.length >= 1 && onJump ? (
          // PR 3 § H.5: re-entry branch. Operator already has at least
          // one agent set up — offer "add another" + "reconfigure"
          // rather than just "re-run setup anyway."
          <>
            <p
              className="text-sm max-w-md mx-auto mb-2"
              style={{ color: 'var(--color-ink)' }}
            >
              You have {existingAgents.length}{' '}
              {existingAgents.length === 1 ? 'agent' : 'agents'} already (
              {existingAgents.map((a) => a.name).join(', ')}). Add another
              agent on a different provider, or reconfigure?
            </p>
            <div className="flex flex-row items-center gap-3">
              <Button size="lg" variant="primary" onClick={addAnotherAgent}>
                Add another agent
              </Button>
              <Button size="lg" variant="ghost" onClick={onNext}>
                Reconfigure
              </Button>
            </div>
            <p
              className="text-xs mt-1"
              style={{
                color: 'var(--color-ink-dim)',
                letterSpacing: 'var(--tracking-caption)'
              }}
            >
              Add another agent skips ahead to provider selection.
            </p>
          </>
        ) : (
          <>
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
          </>
        )}
      </div>
    </div>
  )
}
