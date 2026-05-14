import { useEffect, useState } from 'react'
import { Button } from '../components/Button'
import { Mascot } from '../components/Mascot'
import { useElectronAPI } from '../hooks/useElectronAPI'
import type { HealthSummary } from '@shared/types'

interface Props {
  onNext: () => void
  onBack: () => void
}

// Step 10 — Smoke test.
//
// Mirrors cli/claw-setup/src/steps/10-smoke-test.ts. The CLI polls
// /health every 5s for 60s and reports the first 200 response. For
// solo profile + healthy, it asks the operator to send a test WhatsApp
// message and confirms.
//
// The GUI uses the existing health probe — same endpoint, same logic,
// just with a nicer presentation. The "send a real WhatsApp message"
// confirm is preserved.
export function SmokeStep({ onNext, onBack }: Props) {
  const api = useElectronAPI()
  const [phase, setPhase] = useState<'polling' | 'healthy' | 'unhealthy'>('polling')
  const [health, setHealth] = useState<HealthSummary | null>(null)
  const [profile, setProfile] = useState<string | null>(null)
  const [messageConfirmed, setMessageConfirmed] = useState(false)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (!api) return
    void api.state.read().then((s) => setProfile(s?.profile ?? null))
  }, [api])

  useEffect(() => {
    if (!api) return
    let cancelled = false
    setPhase('polling')
    void (async () => {
      const startedAt = Date.now()
      const timeoutMs = 60000
      let i = 0
      while (Date.now() - startedAt < timeoutMs && !cancelled) {
        i += 1
        setAttempt(i)
        const h = await api.health.probe()
        if (cancelled) return
        setHealth(h)
        if (h.reachable && h.nanoclaw.running) {
          setPhase('healthy')
          await api.state.patch({
            data: { smoke_health_ok: true, smoke_at: new Date().toISOString() }
          })
          return
        }
        await new Promise((r) => setTimeout(r, 3000))
      }
      if (!cancelled) setPhase('unhealthy')
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api])

  const isHobbyist = profile === 'hobbyist'

  function continueAndProceed() {
    if (api) void api.state.patch({ data: { smoke_test_passed: true } })
    onNext()
  }

  return (
    <div className="step-enter flex-1 flex flex-col items-center justify-center px-10 py-7 text-center relative z-10 max-w-2xl mx-auto w-full">
      <div className="mb-5">
        <Mascot
          state={
            phase === 'healthy' ? 'success' : phase === 'unhealthy' ? 'error' : 'loading'
          }
          size={110}
        />
      </div>

      {phase === 'polling' && (
        <>
          <h2
            className="text-2xl mb-2"
            style={{
              color: 'var(--color-ink)',
              letterSpacing: 'var(--tracking-display)',
              fontWeight: 600
            }}
          >
            Smoke test
          </h2>
          <p
            className="text-sm mb-4 max-w-md mx-auto"
            style={{ color: 'var(--color-ink-muted)', lineHeight: 1.55 }}
          >
            Polling <code>/health</code> for up to 60 seconds. The orchestrator just
            started — give it a moment.
          </p>
          <div
            className="text-xs"
            style={{ color: 'var(--color-ink-dim)' }}
          >
            attempt {attempt}
          </div>
        </>
      )}

      {phase === 'healthy' && (
        <>
          <h2
            className="text-2xl mb-2"
            style={{
              color: 'var(--color-ink)',
              letterSpacing: 'var(--tracking-display)',
              fontWeight: 600
            }}
          >
            The orchestrator is alive.
          </h2>
          {health && (
            <div
              className="text-xs mb-5 px-3 py-2 rounded-md inline-flex items-center gap-3"
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

          {isHobbyist ? (
            <p
              className="text-sm mb-5 max-w-md mx-auto"
              style={{ color: 'var(--color-ink-muted)', lineHeight: 1.55 }}
            >
              Hobbyist profile uses local-echo mode. The smoke test is just
              the health check — no WhatsApp round-trip required.
            </p>
          ) : (
            <>
              <p
                className="text-sm mb-3 max-w-md mx-auto"
                style={{ color: 'var(--color-ink-muted)', lineHeight: 1.55 }}
              >
                Send a quick message in your main WhatsApp group to confirm
                the agent responds end-to-end.
              </p>
              <label
                className="panel inline-flex items-center gap-3 px-4 py-2.5 cursor-pointer mb-5"
                style={{ borderRadius: 'var(--radius-md)' }}
              >
                <input
                  type="checkbox"
                  checked={messageConfirmed}
                  onChange={(e) => setMessageConfirmed(e.target.checked)}
                  className="accent-[color:var(--color-ink)]"
                />
                <span className="text-sm" style={{ color: 'var(--color-ink)' }}>
                  I&apos;ve sent a test message and the agent replied
                </span>
              </label>
            </>
          )}
        </>
      )}

      {phase === 'unhealthy' && (
        <>
          <h2
            className="text-2xl mb-2"
            style={{
              color: 'var(--color-ink)',
              letterSpacing: 'var(--tracking-display)',
              fontWeight: 600
            }}
          >
            /health didn&apos;t respond in 60s.
          </h2>
          <p
            className="text-sm mb-5 max-w-md mx-auto"
            style={{ color: 'var(--color-ink-muted)', lineHeight: 1.55 }}
          >
            Step 09 installs the service. If the service is loaded but the
            process isn&apos;t healthy, check{' '}
            <code>~/factotem/.logs/nanoclaw.err.log</code> for a clue.
          </p>
        </>
      )}

      <div className="flex items-center justify-between gap-3 mt-auto pt-6 w-full">
        <Button variant="ghost" onClick={onBack}>
          Back
        </Button>
        <Button
          onClick={continueAndProceed}
          disabled={phase !== 'healthy' || (!isHobbyist && !messageConfirmed)}
        >
          Continue
        </Button>
      </div>
    </div>
  )
}
