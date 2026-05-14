import { useEffect, useState } from 'react'
import { Button } from '../components/Button'
import { CommandBlock } from '../components/CommandBlock'
import { useElectronAPI } from '../hooks/useElectronAPI'
import type { ServiceInstallResult } from '@shared/types'

interface Props {
  onNext: () => void
  onBack: () => void
}

// Step 09 — Install launchd/systemd service.
//
// Mirrors cli/claw-setup/src/steps/09-install-launchd.ts. macOS path
// is fully implemented in the GUI: render plist → write to
// ~/Library/LaunchAgents/com.nanoclaw.plist → launchctl bootstrap.
// Linux/WSL path is a CLI handoff because systemd installation has
// its own daemon-reload + enable flow that's worth keeping in the
// orchestrator's setup/service.ts for now.
export function ServiceStep({ onNext, onBack }: Props) {
  const api = useElectronAPI()
  const [orchestratorRoot, setOrchestratorRoot] = useState<string | null>(null)
  const [platform, setPlatform] = useState<string>('')
  const [loaded, setLoaded] = useState<boolean | null>(null)
  const [installing, setInstalling] = useState(false)
  const [result, setResult] = useState<ServiceInstallResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!api) return
    void api.env.check().then((env) => setOrchestratorRoot(env.orchestratorRoot))
    void api.app.platform().then(setPlatform)
    void api.service.status().then(setLoaded)
  }, [api])

  const isMacOS = platform.toLowerCase().startsWith('macos')

  async function install() {
    if (!api || !orchestratorRoot) return
    setInstalling(true)
    setError(null)
    try {
      const r = await api.service.install(orchestratorRoot)
      setResult(r)
      if (r.success) {
        setLoaded(true)
        await api.state.patch({
          data: { service_installed: true, service_plist: r.plistPath }
        })
      } else {
        setError(r.error ?? 'Service install failed')
      }
    } finally {
      setInstalling(false)
    }
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
          Install the background service
        </h2>
        <p
          className="text-sm"
          style={{ color: 'var(--color-ink-muted)', lineHeight: 1.55 }}
        >
          The orchestrator runs as a background service so the agent
          stays online without your terminal staying open. On macOS we
          install a launchd plist labelled <code>com.nanoclaw</code>.
        </p>
      </div>

      <div
        className="panel px-4 py-3 mb-5 flex items-start gap-3"
        style={{ borderRadius: 'var(--radius-md)' }}
      >
        <span
          className="w-2 h-2 rounded-full mt-2"
          style={{
            background:
              loaded === null
                ? 'var(--color-ink-dim)'
                : loaded
                  ? 'var(--color-success)'
                  : 'var(--color-warning)'
          }}
        />
        <div className="flex-1">
          <div className="text-sm" style={{ color: 'var(--color-ink)' }}>
            {loaded === null
              ? 'Checking service status…'
              : loaded
                ? 'Service is loaded and running'
                : 'Service not installed yet'}
          </div>
          <div className="text-xs mt-0.5" style={{ color: 'var(--color-ink-muted)' }}>
            {platform || 'detecting platform…'}
          </div>
        </div>
      </div>

      {!isMacOS && (
        <div
          className="mb-5 px-4 py-3 rounded-md"
          style={{
            color: 'var(--color-warning)',
            background: 'var(--color-warning-bg)'
          }}
        >
          <div className="text-sm font-medium mb-2">
            Linux / WSL — install via the CLI
          </div>
          <div className="text-xs mb-2" style={{ color: 'var(--color-ink-muted)' }}>
            Systemd setup needs daemon-reload + enable + start. Easiest is to resume
            the CLI wizard.
          </div>
          <CommandBlock
            command={
              orchestratorRoot
                ? `cd ${orchestratorRoot} && npm run claw-setup -- --resume`
                : `cd ~/factotem && npm run claw-setup -- --resume`
            }
          />
        </div>
      )}

      {result?.success && (
        <div
          className="mb-4 px-3 py-2 rounded-md text-sm"
          style={{ color: 'var(--color-success)', background: 'var(--color-success-bg)' }}
        >
          Plist written to <code>{result.plistPath}</code> and bootstrapped.
        </div>
      )}

      {error && (
        <div
          className="text-sm mb-4 px-3 py-2 rounded-md"
          style={{ color: 'var(--color-error)', background: 'var(--color-error-bg)' }}
        >
          {error}
        </div>
      )}

      <div className="flex items-center justify-between gap-3 mt-auto pt-6">
        <Button variant="ghost" onClick={onBack}>
          Back
        </Button>
        <div className="flex items-center gap-3">
          {isMacOS && !loaded && (
            <Button onClick={install} loading={installing} disabled={!orchestratorRoot}>
              Install &amp; start service
            </Button>
          )}
          <Button onClick={onNext} disabled={isMacOS && !loaded && !result?.success}>
            Continue
          </Button>
        </div>
      </div>
    </div>
  )
}
