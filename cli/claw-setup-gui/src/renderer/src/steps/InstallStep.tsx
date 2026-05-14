import { useEffect, useState } from 'react'
import { Button } from '../components/Button'
import { DiagnosticCard } from '../components/DiagnosticCard'
import { useElectronAPI } from '../hooks/useElectronAPI'
import type { EnvCheckResult, ProbeResult } from '@shared/types'

interface Props {
  onNext: () => void
  onBack: () => void
}

// Step 02 — Install prerequisites.
//
// Mirrors cli/claw-setup/src/steps/02-install-prerequisites.ts. The CLI
// step asks the operator to confirm each missing prereq has been
// installed. We follow the same pattern here: re-probe on demand, let
// the user mark items "Installed" once they've handled them manually,
// continue when nothing is blocking.
export function InstallStep({ onNext, onBack }: Props) {
  const api = useElectronAPI()
  const [result, setResult] = useState<EnvCheckResult | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [acknowledged, setAcknowledged] = useState<Record<string, boolean>>({})

  async function probe() {
    if (!api) return
    setRefreshing(true)
    try {
      setResult(await api.env.check())
    } finally {
      setRefreshing(false)
    }
  }

  useEffect(() => {
    if (!api) return
    void probe()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api])

  const probes: ProbeResult[] = result?.probes ?? []
  const missing = probes.filter((p) => !p.ok)
  const allHandled = missing.every((p) => acknowledged[p.name] || p.ok)

  return (
    <div className="step-enter flex-1 flex flex-col px-10 py-7 relative z-10 max-w-2xl mx-auto w-full">
      <div className="mb-6">
        <h2
          className="text-2xl mb-1"
          style={{
            color: 'var(--color-ink)',
            letterSpacing: 'var(--tracking-display)',
            fontWeight: 600
          }}
        >
          Install what&apos;s missing
        </h2>
        <p
          className="text-sm"
          style={{ color: 'var(--color-ink-muted)', lineHeight: 1.55 }}
        >
          Use the Install links to open each vendor&apos;s download page.
          After installing, click <strong>Re-check</strong> — or
          <strong>Mark installed</strong> if the wizard can&apos;t see the
          new binary yet.
        </p>
      </div>

      <div className="flex flex-col gap-2.5 mb-6">
        {probes.map((p) => {
          if (p.ok) {
            return (
              <DiagnosticCard key={p.name} probe={p} />
            )
          }
          const ackd = acknowledged[p.name] === true
          return (
            <div key={p.name}>
              <DiagnosticCard
                probe={ackd ? { ...p, status: 'ok', detail: 'marked installed — re-check pending', ok: true } : p}
                onOpenInstall={
                  api && !ackd
                    ? () => api.shell.openExternal(p.installUrl)
                    : undefined
                }
              />
              {!ackd && (
                <div className="flex justify-end mt-1.5">
                  <button
                    type="button"
                    onClick={() => setAcknowledged((s) => ({ ...s, [p.name]: true }))}
                    className="text-xs hover:underline"
                    style={{ color: 'var(--color-ink-muted)' }}
                  >
                    Mark {p.name} installed
                  </button>
                </div>
              )}
            </div>
          )
        })}
      </div>

      {missing.length === 0 && probes.length > 0 && (
        <div
          className="text-sm mb-4 px-3 py-2 rounded-md"
          style={{ color: 'var(--color-success)', background: 'var(--color-success-bg)' }}
        >
          Everything looks installed. You can continue.
        </div>
      )}

      <div className="flex items-center justify-between gap-3 mt-auto pt-6">
        <Button variant="ghost" onClick={onBack}>
          Back
        </Button>
        <div className="flex items-center gap-3">
          <Button variant="ghost" onClick={probe} loading={refreshing}>
            Re-check
          </Button>
          <Button onClick={onNext} disabled={!allHandled}>
            Continue
          </Button>
        </div>
      </div>
    </div>
  )
}
