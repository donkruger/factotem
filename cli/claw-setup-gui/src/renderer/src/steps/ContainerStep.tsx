import { useEffect, useRef, useState } from 'react'
import { Button } from '../components/Button'
import { LogViewer } from '../components/LogViewer'
import { useElectronAPI } from '../hooks/useElectronAPI'

interface Props {
  onNext: () => void
  onBack: () => void
}

// Step 05 — Build agent container.
//
// Mirrors cli/claw-setup/src/steps/05-build-container.ts. The CLI runs
// `~/container/build.sh` with a 30s heartbeat for ~3–5 minutes. We run
// the same script via the subprocess streaming bridge and surface each
// stdout/stderr line into the LogViewer.
//
// The orchestrator root comes from env.check() — we look in the
// detected root for ./container/build.sh.
export function ContainerStep({ onNext, onBack }: Props) {
  const api = useElectronAPI()
  const [orchestratorRoot, setOrchestratorRoot] = useState<string | null>(null)
  const [lines, setLines] = useState<string[]>([])
  const [phase, setPhase] = useState<'idle' | 'running' | 'done' | 'failed'>('idle')
  const [exitCode, setExitCode] = useState<number | null>(null)
  const [skipped, setSkipped] = useState(false)
  const runIdRef = useRef<string | null>(null)
  const cleanupRef = useRef<Array<() => void>>([])

  useEffect(() => {
    if (!api) return
    void api.env.check().then((env) => setOrchestratorRoot(env.orchestratorRoot))
    void api.state.read().then((s) => {
      if (s?.completedSteps?.includes('05-build-container')) {
        setPhase('done')
      }
    })
  }, [api])

  useEffect(() => {
    return () => {
      cleanupRef.current.forEach((fn) => fn())
      cleanupRef.current = []
    }
  }, [])

  async function build() {
    if (!api || !orchestratorRoot) return
    setLines([])
    setPhase('running')
    setExitCode(null)
    cleanupRef.current.forEach((fn) => fn())
    cleanupRef.current = []

    const { runId } = await api.subprocess.start({
      cmd: 'bash',
      args: ['container/build.sh'],
      cwd: orchestratorRoot
    })
    runIdRef.current = runId

    const offLine = api.subprocess.onLine(runId, (line) =>
      setLines((prev) => [...prev.slice(-499), line])
    )
    const offExit = api.subprocess.onExit(runId, ({ code }) => {
      setExitCode(code)
      setPhase(code === 0 ? 'done' : 'failed')
      if (code === 0) {
        void api.state.patch({
          data: { container_built_at: new Date().toISOString() }
        })
      }
    })

    cleanupRef.current.push(offLine, offExit)
  }

  function cancel() {
    if (runIdRef.current && api) {
      void api.subprocess.cancel(runIdRef.current)
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
          Build the agent container
        </h2>
        <p
          className="text-sm"
          style={{ color: 'var(--color-ink-muted)', lineHeight: 1.55 }}
        >
          Builds the Linux container image the agent runs inside.
          Typically 3–5 minutes — most of it downloads. You can leave
          this running and come back.
        </p>
      </div>

      {!orchestratorRoot && (
        <div
          className="mb-4 px-3 py-2 rounded-md text-sm"
          style={{ color: 'var(--color-warning)', background: 'var(--color-warning-bg)' }}
        >
          NanoClaw checkout not detected. Set up the orchestrator first, then come back.
        </div>
      )}

      {orchestratorRoot && (
        <div
          className="mb-4 px-3 py-2 rounded-md text-xs"
          style={{ color: 'var(--color-ink-muted)', background: 'var(--color-bg-elevated)' }}
        >
          Building from <code>{orchestratorRoot}/container/build.sh</code>
        </div>
      )}

      <div className="mb-4">
        <LogViewer lines={lines} empty="Click Build to start. Output streams here." maxHeight={260} />
      </div>

      {phase === 'done' && (
        <div
          className="text-sm mb-4 px-3 py-2 rounded-md"
          style={{ color: 'var(--color-success)', background: 'var(--color-success-bg)' }}
        >
          Container built successfully.
        </div>
      )}
      {phase === 'failed' && (
        <div
          className="text-sm mb-4 px-3 py-2 rounded-md"
          style={{ color: 'var(--color-error)', background: 'var(--color-error-bg)' }}
        >
          Build exited with code {exitCode}. Scroll the log above for the failure point.
        </div>
      )}

      <div className="flex items-center justify-between gap-3 mt-auto pt-6">
        <Button variant="ghost" onClick={onBack} disabled={phase === 'running'}>
          Back
        </Button>
        <div className="flex items-center gap-3">
          {phase === 'running' ? (
            <Button variant="ghost" onClick={cancel}>
              Cancel
            </Button>
          ) : (
            <Button
              variant="ghost"
              onClick={() => {
                setSkipped(true)
                onNext()
              }}
            >
              Skip — I built it elsewhere
            </Button>
          )}
          <Button
            onClick={phase === 'done' || skipped ? onNext : build}
            loading={phase === 'running'}
            disabled={!orchestratorRoot || phase === 'running'}
          >
            {phase === 'done' ? 'Continue' : phase === 'failed' ? 'Retry build' : 'Build'}
          </Button>
        </div>
      </div>
    </div>
  )
}
