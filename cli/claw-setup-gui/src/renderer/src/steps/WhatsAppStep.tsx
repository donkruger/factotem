import { useEffect, useRef, useState } from 'react'
import QRCode from 'qrcode'
import { Button } from '../components/Button'
import { CommandBlock } from '../components/CommandBlock'
import { LogViewer } from '../components/LogViewer'
import { Mascot } from '../components/Mascot'
import { useElectronAPI } from '../hooks/useElectronAPI'

interface Props {
  onNext: () => void
  onBack: () => void
}

type Phase = 'idle' | 'starting' | 'scanning' | 'success' | 'failed'

// Step 06 — Pair WhatsApp.
//
// The orchestrator's `src/whatsapp-auth.ts` writes the raw QR payload
// to `<root>/store/qr-data.txt` and the auth status to
// `<root>/store/auth-status.txt` while the Baileys socket runs. The
// main process polls those two files and streams updates over IPC,
// so the GUI can render a real, crisp QR (via the `qrcode` lib) and
// a live status indicator.
//
// The default QR-scan flow needs no stdin, so it runs entirely inside
// the wizard. The pairing-code flow (which reads a phone number from
// stdin) still hands off to Terminal — that's a future iteration once
// we wire bidirectional subprocess I/O.
export function WhatsAppStep({ onNext, onBack }: Props) {
  const api = useElectronAPI()
  const [orchestratorRoot, setOrchestratorRoot] = useState<string | null>(null)
  const [profile, setProfile] = useState<string | null>(null)
  const [phase, setPhase] = useState<Phase>('idle')
  const [status, setStatus] = useState<string>('')
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null)
  const [lines, setLines] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  // Per-pairing context (v1.2.1-finish-blueprint § 2). When the wizard
  // entered this step via the add-agent → "pair a new WhatsApp number"
  // branch, PairingChoiceStep stashes a pairingId + auth directory on
  // setup state.data; we read them once on mount and pass them through
  // to api.whatsapp.start so the auth script writes to a per-pairing
  // store/auth-<id>/ directory and store/qr-data-<id>.txt /
  // store/auth-status-<id>.txt hand-off files. Absent = v1.0 behaviour
  // (the deployment's shared WhatsApp account into store/auth/).
  const [pendingPairingId, setPendingPairingId] = useState<string | undefined>(undefined)
  const [pendingAuthDir, setPendingAuthDir] = useState<string | undefined>(undefined)
  const runIdRef = useRef<string | null>(null)
  const cleanupRef = useRef<Array<() => void>>([])

  useEffect(() => {
    if (!api) return
    void api.env.check().then((env) => setOrchestratorRoot(env.orchestratorRoot))
    void api.state.read().then((s) => {
      if (s) {
        setProfile(s.profile)
        const pid = s.data['__pending_pairing_id']
        const adir = s.data['__pending_pairing_auth_dir']
        if (typeof pid === 'string') setPendingPairingId(pid)
        if (typeof adir === 'string') setPendingAuthDir(adir)
        // When a per-pairing context is set we never want to short-circuit
        // to the "already paired" success state — that flag refers to the
        // *shared* WhatsApp account, not the new one we're about to pair.
        if (s.data['whatsapp_paired_at'] && !pid) {
          setPhase('success')
          setStatus('already paired')
        }
      }
    })
    return () => {
      cleanupRef.current.forEach((fn) => fn())
      if (runIdRef.current) void api.whatsapp.cancel(runIdRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api])

  async function start() {
    if (!api || !orchestratorRoot) return
    setError(null)
    setLines([])
    setQrDataUrl(null)
    setStatus('')
    setPhase('starting')

    try {
      const { runId } = await api.whatsapp.start(orchestratorRoot, {
        pairingId: pendingPairingId,
        authDir: pendingAuthDir
      })
      runIdRef.current = runId

      const offQr = api.whatsapp.onQr(runId, async (qr) => {
        try {
          // Render the QR as an SVG-data-URL — looks crisp at any zoom
          // and survives Electron's compositor without anti-aliasing.
          const svg = await QRCode.toString(qr, {
            type: 'svg',
            margin: 1,
            color: { dark: '#1d1d1f', light: '#ffffff' },
            errorCorrectionLevel: 'M'
          })
          const url = `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`
          setQrDataUrl(url)
          setPhase('scanning')
        } catch (err) {
          setError(`Failed to render QR: ${(err as Error).message}`)
        }
      })

      const offStatus = api.whatsapp.onStatus(runId, async (s) => {
        setStatus(s)
        if (s === 'authenticated' || s === 'already_authenticated') {
          setPhase('success')
          // For a per-pairing run, stash the success against the
          // pairing id and clear the hand-off flags so a subsequent
          // wizard pass doesn't re-pair the same number. For a
          // shared-account run, update the legacy whatsapp_paired_at
          // flag so existing readers keep working.
          if (pendingPairingId) {
            await api.state.patch({
              data: {
                [`__pairing_${pendingPairingId}_paired_at`]:
                  new Date().toISOString(),
                __pending_pairing_id: undefined,
                __pending_pairing_auth_dir: undefined
              }
            })
          } else {
            await api.state.patch({
              data: { whatsapp_paired_at: new Date().toISOString() }
            })
          }
        } else if (s.startsWith('failed:')) {
          setPhase('failed')
          setError(`Pairing failed (${s.slice('failed:'.length)})`)
        } else if (s.startsWith('pairing_code:')) {
          setPhase('scanning')
        }
      })

      const offLine = api.whatsapp.onLine(runId, (line) =>
        setLines((prev) => [...prev.slice(-499), ...line.split(/\r?\n/).filter(Boolean)])
      )

      const offExit = api.whatsapp.onExit(runId, ({ code }) => {
        runIdRef.current = null
        if (phase !== 'success' && code !== 0) {
          setPhase('failed')
          if (!error) setError(`Auth script exited with code ${code}`)
        }
      })

      cleanupRef.current = [offQr, offStatus, offLine, offExit]
    } catch (err) {
      setError((err as Error).message)
      setPhase('failed')
    }
  }

  async function cancel() {
    if (!api || !runIdRef.current) return
    await api.whatsapp.cancel(runIdRef.current)
    runIdRef.current = null
    setPhase('idle')
    setStatus('cancelled')
  }

  const isHobbyist = profile === 'hobbyist'

  if (isHobbyist) {
    return (
      <div className="step-enter flex-1 flex flex-col px-10 py-7 relative z-10 max-w-2xl mx-auto w-full">
        <Header />
        <div
          className="panel px-4 py-3 mb-5 text-sm"
          style={{ color: 'var(--color-ink-muted)', borderRadius: 'var(--radius-md)' }}
        >
          You picked the hobbyist profile — no real WhatsApp pairing required.
          The orchestrator will use local-echo mode.
        </div>
        <Footer onBack={onBack} primary={<Button onClick={onNext}>Continue (skip pairing)</Button>} />
      </div>
    )
  }

  return (
    <div className="step-enter flex-1 flex flex-col px-10 py-7 relative z-10 max-w-2xl mx-auto w-full">
      <Header />

      {phase === 'idle' && (
        <IdlePanel
          orchestratorRoot={orchestratorRoot}
          onStart={start}
          api={api}
        />
      )}

      {(phase === 'starting' || phase === 'scanning' || phase === 'failed') && (
        <ScanPanel
          phase={phase}
          qrDataUrl={qrDataUrl}
          status={status}
          lines={lines}
          onCancel={cancel}
        />
      )}

      {phase === 'success' && (
        <SuccessPanel status={status} />
      )}

      {error && (
        <div
          className="text-sm mb-4 px-3 py-2 rounded-md"
          style={{ color: 'var(--color-error)', background: 'var(--color-error-bg)' }}
        >
          {error}
        </div>
      )}

      <Footer
        onBack={onBack}
        primary={
          phase === 'success' ? (
            <Button onClick={onNext}>Continue</Button>
          ) : (
            <Button onClick={onNext} variant="ghost">
              Skip — I&apos;ll pair later
            </Button>
          )
        }
      />
    </div>
  )
}

// ─── Sub-components ────────────────────────────────────────────────────────

function Header() {
  return (
    <div className="mb-5">
      <h2
        className="text-2xl mb-1"
        style={{
          color: 'var(--color-ink)',
          letterSpacing: 'var(--tracking-display)',
          fontWeight: 600
        }}
      >
        Pair WhatsApp
      </h2>
      <p
        className="text-sm"
        style={{ color: 'var(--color-ink-muted)', lineHeight: 1.55 }}
      >
        Scan the QR code with your phone&apos;s WhatsApp app to link this
        machine. The credentials are stored locally in the orchestrator&apos;s
        <code> store/auth/</code> directory — never sent anywhere.
      </p>
    </div>
  )
}

function IdlePanel({
  orchestratorRoot,
  onStart,
  api
}: {
  orchestratorRoot: string | null
  onStart: () => void
  api: Window['electronAPI'] | null
}) {
  return (
    <>
      <div className="flex items-start gap-4 mb-5">
        <Mascot state="idle" size={84} />
        <div className="flex-1">
          <h3
            className="text-base font-semibold mb-1"
            style={{ color: 'var(--color-ink)' }}
          >
            Ready to pair
          </h3>
          <ol className="text-xs space-y-1.5" style={{ color: 'var(--color-ink-muted)' }}>
            <li>
              <strong style={{ color: 'var(--color-ink)' }}>1.</strong> Click <strong>Start
              pairing</strong> below.
            </li>
            <li>
              <strong style={{ color: 'var(--color-ink)' }}>2.</strong> Open WhatsApp on your
              phone → Settings → Linked Devices → Link a Device.
            </li>
            <li>
              <strong style={{ color: 'var(--color-ink)' }}>3.</strong> Point your camera at the
              QR code that appears here.
            </li>
            <li>
              <strong style={{ color: 'var(--color-ink)' }}>4.</strong> Pairing usually takes
              10–30 seconds.
            </li>
          </ol>
        </div>
      </div>

      <div className="flex items-center gap-3 mb-5">
        <Button variant="accent" onClick={onStart} disabled={!orchestratorRoot}>
          Start pairing
        </Button>
        {!orchestratorRoot && (
          <span className="text-xs" style={{ color: 'var(--color-warning)' }}>
            Orchestrator checkout not detected — see env-check step
          </span>
        )}
      </div>

      <details className="mb-4">
        <summary
          className="text-xs cursor-pointer"
          style={{ color: 'var(--color-ink-muted)' }}
        >
          Want pairing-code mode instead? (e.g. phone camera can&apos;t see the QR)
        </summary>
        <div
          className="mt-2 text-xs"
          style={{ color: 'var(--color-ink-muted)', lineHeight: 1.55 }}
        >
          Pairing-code mode needs to read your phone number from stdin, so it
          still runs in a terminal for now. Run the command below in a new
          terminal window — when the script asks, enter your number without
          spaces or the leading <code>+</code> (e.g. <code>14155551234</code>).
          <CommandBlock
            command={
              orchestratorRoot
                ? `cd ${orchestratorRoot} && npx tsx src/whatsapp-auth.ts --pairing-code`
                : `cd ~/factotem && npx tsx src/whatsapp-auth.ts --pairing-code`
            }
            showOpenTerminal={!!api}
          />
        </div>
      </details>
    </>
  )
}

function ScanPanel({
  phase,
  qrDataUrl,
  status,
  lines,
  onCancel
}: {
  phase: Phase
  qrDataUrl: string | null
  status: string
  lines: string[]
  onCancel: () => void
}) {
  return (
    <>
      <div className="flex flex-col items-center mb-5">
        <div
          className="panel-elevated flex items-center justify-center mb-3"
          style={{
            width: 280,
            height: 280,
            padding: 16,
            borderRadius: 'var(--radius-lg)'
          }}
        >
          {qrDataUrl ? (
            <img
              src={qrDataUrl}
              alt="WhatsApp pairing QR code"
              style={{ width: '100%', height: '100%', imageRendering: 'pixelated' }}
            />
          ) : (
            <div
              className="text-sm text-center px-4"
              style={{ color: 'var(--color-ink-muted)' }}
            >
              {phase === 'starting'
                ? 'Starting auth script…'
                : 'Waiting for QR code from Baileys…'}
            </div>
          )}
        </div>

        <div
          className="text-xs flex items-center gap-2"
          style={{ color: 'var(--color-ink-muted)' }}
        >
          <span
            className="w-2 h-2 rounded-full"
            style={{
              background:
                phase === 'failed'
                  ? 'var(--color-error)'
                  : qrDataUrl
                    ? 'var(--color-accent)'
                    : 'var(--color-ink-dim)'
            }}
          />
          {status || (qrDataUrl ? 'Scan with WhatsApp on your phone' : 'connecting…')}
        </div>
      </div>

      <details className="mb-4">
        <summary
          className="text-xs cursor-pointer mb-2"
          style={{ color: 'var(--color-ink-muted)' }}
        >
          Show auth script output
        </summary>
        <LogViewer lines={lines} maxHeight={200} empty="No output yet…" />
      </details>

      <div className="flex justify-end mb-2">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel pairing
        </Button>
      </div>
    </>
  )
}

function SuccessPanel({ status }: { status: string }) {
  return (
    <div className="flex items-center gap-4 mb-5">
      <Mascot state="success" size={72} />
      <div className="flex-1">
        <h3
          className="text-base font-semibold mb-1"
          style={{ color: 'var(--color-ink)' }}
        >
          Paired
        </h3>
        <p className="text-sm" style={{ color: 'var(--color-ink-muted)' }}>
          {status === 'already_authenticated'
            ? 'This machine was already paired with WhatsApp. Nothing to do here.'
            : 'WhatsApp is linked. Credentials saved to the orchestrator. Move on to install the background service.'}
        </p>
      </div>
    </div>
  )
}

function Footer({
  onBack,
  primary
}: {
  onBack: () => void
  primary: React.ReactNode
}) {
  return (
    <div className="flex items-center justify-between gap-3 mt-auto pt-6">
      <Button variant="ghost" onClick={onBack}>
        Back
      </Button>
      <div className="flex items-center gap-3">{primary}</div>
    </div>
  )
}
