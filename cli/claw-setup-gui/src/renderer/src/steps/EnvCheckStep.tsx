import { useEffect, useState } from 'react'
import { Button } from '../components/Button'
import { DiagnosticCard } from '../components/DiagnosticCard'
import { useElectronAPI } from '../hooks/useElectronAPI'
import type { EnvCheckResult, ProbeResult } from '@shared/types'

interface Props {
  onNext: () => void
  onBack: () => void
}

export function EnvCheckStep({ onNext, onBack }: Props) {
  const api = useElectronAPI()
  const [result, setResult] = useState<EnvCheckResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  async function runCheck() {
    if (!api) return
    setLoading(true)
    setError(null)
    try {
      const res = await api.env.check()
      setResult(res)
    } catch (e) {
      setError((e as Error).message || 'Environment check failed')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (!api) return
    void runCheck()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api])

  const skeletonProbe = (name: string): ProbeResult => ({
    name,
    ok: false,
    detail: 'checking…',
    installUrl: '',
    status: 'checking'
  })

  const probes: ProbeResult[] = result?.probes ?? [
    skeletonProbe('Node.js'),
    skeletonProbe('Docker'),
    skeletonProbe('Tailscale')
  ]

  const nodeOk = probes.find((p) => p.name === 'Node.js')?.ok ?? false
  const allOk = probes.every((p) => p.ok)

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
          Checking prerequisites
        </h2>
        <p
          className="text-sm"
          style={{
            color: 'var(--color-ink-muted)',
            lineHeight: 1.55
          }}
        >
          The orchestrator needs Node.js, a container runtime, and Tailscale.
          Anything missing or unhealthy will show up here.
        </p>
      </div>

      <div className="flex flex-col gap-2.5 mb-6">
        {probes.map((p) => (
          <DiagnosticCard
            key={p.name}
            probe={p}
            onOpenInstall={
              p.installUrl && api
                ? () => api.shell.openExternal(p.installUrl)
                : undefined
            }
          />
        ))}
      </div>

      {result?.orchestratorRoot && (
        <div
          className="text-xs mb-4 px-3 py-2 rounded-md"
          style={{
            color: 'var(--color-ink-muted)',
            background: 'var(--color-bg-elevated)',
            border: '1px solid var(--color-hairline)'
          }}
        >
          Detected NanoClaw at <code>{result.orchestratorRoot}</code>
        </div>
      )}

      {error && (
        <div
          className="text-sm mb-4 px-3 py-2 rounded-md"
          style={{
            color: 'var(--color-error)',
            background: 'var(--color-error-bg)'
          }}
        >
          {error}
        </div>
      )}

      <div className="flex items-center justify-between gap-3 mt-auto pt-6">
        <Button variant="ghost" onClick={onBack}>
          Back
        </Button>
        <div className="flex items-center gap-3">
          <Button variant="ghost" onClick={runCheck} loading={loading}>
            Re-check
          </Button>
          <Button onClick={onNext} disabled={!nodeOk}>
            {allOk ? 'Continue' : nodeOk ? 'Continue anyway' : 'Install Node ≥20 to continue'}
          </Button>
        </div>
      </div>
    </div>
  )
}
