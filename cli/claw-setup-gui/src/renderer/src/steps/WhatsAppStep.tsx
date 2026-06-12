import { useEffect, useRef, useState } from 'react'
import QRCode from 'qrcode'
import { Button } from '../components/Button'
import { LogViewer } from '../components/LogViewer'
import { Mascot } from '../components/Mascot'
import { useElectronAPI } from '../hooks/useElectronAPI'

interface Props {
  onNext: () => void
  onBack: () => void
}

type Phase = 'idle' | 'starting' | 'scanning' | 'success' | 'failed'
type Method = 'qr' | 'pairing-code'

// Step 06 — Pair WhatsApp.
//
// QR scan is the primary, reliable path (ben-log 2026-06-12: pairing-code
// can silently fail device-side while QR works). Pairing-code is offered as
// an in-wizard secondary ("Link with phone number") — the orchestrator's
// `src/whatsapp-auth.ts` takes `--pairing-code --phone <num>` and writes the
// code to the status file as `pairing_code:<code>`, so no terminal hand-off
// is needed. If a device never prompts, the operator can flip back to QR.
//
// The main process polls `store/qr-data*.txt` + `store/auth-status*.txt`
// while the Baileys subprocess runs and streams updates over IPC. On a
// retry / method switch we pass `reset: true` so a prior failed attempt's
// partial creds can't wedge the new one.
export function WhatsAppStep({ onNext, onBack }: Props) {
  const api = useElectronAPI()
  const [orchestratorRoot, setOrchestratorRoot] = useState<string | null>(null)
  const [profile, setProfile] = useState<string | null>(null)
  const [phase, setPhase] = useState<Phase>('idle')
  const [method, setMethod] = useState<Method>('qr')
  const [status, setStatus] = useState<string>('')
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null)
  const [pairingCode, setPairingCode] = useState<string | null>(null)
  const [linkedNumber, setLinkedNumber] = useState<string | null>(null)
  const [lines, setLines] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  // Phone-number entry for the pairing-code path (digits only).
  const [showPhoneEntry, setShowPhoneEntry] = useState(false)
  const [phone, setPhone] = useState('')
  // Per-pairing context (v1.2.1-finish-blueprint § 2) — see prior comment.
  const [pendingPairingId, setPendingPairingId] = useState<string | undefined>(undefined)
  const [pendingAuthDir, setPendingAuthDir] = useState<string | undefined>(undefined)
  const runIdRef = useRef<string | null>(null)
  const cleanupRef = useRef<Array<() => void>>([])
  const phaseRef = useRef<Phase>('idle')
  phaseRef.current = phase

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

  function teardownRun(): void {
    cleanupRef.current.forEach((fn) => fn())
    cleanupRef.current = []
    if (runIdRef.current && api) void api.whatsapp.cancel(runIdRef.current)
    runIdRef.current = null
  }

  // Start (or restart) a pairing attempt. `nextMethod` selects QR vs
  // pairing-code; `reset` wipes any prior partial creds first.
  async function start(nextMethod: Method, opts: { reset?: boolean } = {}): Promise<void> {
    if (!api || !orchestratorRoot) return
    if (nextMethod === 'pairing-code' && !phone.trim()) {
      setShowPhoneEntry(true)
      return
    }
    teardownRun()
    setMethod(nextMethod)
    setError(null)
    setLines([])
    setQrDataUrl(null)
    setPairingCode(null)
    setStatus('')
    setPhase('starting')

    try {
      const { runId } = await api.whatsapp.start(orchestratorRoot, {
        pairingId: pendingPairingId,
        authDir: pendingAuthDir,
        method: nextMethod,
        phone: nextMethod === 'pairing-code' ? phone.replace(/[^\d]/g, '') : undefined,
        reset: opts.reset
      })
      runIdRef.current = runId

      const offQr = api.whatsapp.onQr(runId, async (qr) => {
        // Only render the QR in QR mode — in pairing-code mode Baileys may
        // also emit a QR, but the operator is following the code path.
        if (nextMethod !== 'qr') return
        try {
          const svg = await QRCode.toString(qr, {
            type: 'svg',
            margin: 1,
            color: { dark: '#1d1d1f', light: '#ffffff' },
            errorCorrectionLevel: 'M'
          })
          setQrDataUrl(`data:image/svg+xml;utf8,${encodeURIComponent(svg)}`)
          setPhase('scanning')
        } catch (err) {
          setError(`Failed to render QR: ${(err as Error).message}`)
        }
      })

      const offStatus = api.whatsapp.onStatus(runId, async (s) => {
        setStatus(s)
        if (s === 'authenticated' || s.startsWith('authenticated:') || s === 'already_authenticated') {
          if (s.startsWith('authenticated:')) setLinkedNumber(s.slice('authenticated:'.length))
          setPhase('success')
          if (pendingPairingId) {
            await api.state.patch({
              data: {
                [`__pairing_${pendingPairingId}_paired_at`]: new Date().toISOString(),
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
          setError(null)
        } else if (s.startsWith('pairing_code:')) {
          setPairingCode(s.slice('pairing_code:'.length))
          setPhase('scanning')
        }
      })

      const offLine = api.whatsapp.onLine(runId, (line) =>
        setLines((prev) => [...prev.slice(-499), ...line.split(/\r?\n/).filter(Boolean)])
      )

      const offExit = api.whatsapp.onExit(runId, ({ code }) => {
        runIdRef.current = null
        if (phaseRef.current !== 'success' && code !== 0) {
          setPhase('failed')
        }
      })

      cleanupRef.current = [offQr, offStatus, offLine, offExit]
    } catch (err) {
      setError((err as Error).message)
      setPhase('failed')
    }
  }

  async function cancel(): Promise<void> {
    teardownRun()
    setPhase('idle')
    setStatus('cancelled')
    setQrDataUrl(null)
    setPairingCode(null)
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
          onStart={() => void start('qr')}
        />
      )}

      {(phase === 'starting' || phase === 'scanning') && (
        <ScanPanel
          method={method}
          qrDataUrl={qrDataUrl}
          pairingCode={pairingCode}
          status={status}
          lines={lines}
          phone={phone}
          showPhoneEntry={showPhoneEntry}
          onPhoneChange={setPhone}
          onTogglePhoneEntry={() => setShowPhoneEntry((v) => !v)}
          onGetCode={() => void start('pairing-code', { reset: true })}
          onBackToQr={() => void start('qr', { reset: true })}
          onCancel={() => void cancel()}
        />
      )}

      {phase === 'failed' && (
        <FailedPanel
          method={method}
          status={status}
          error={error}
          lines={lines}
          onRetry={() => void start(method, { reset: true })}
          onBackToQr={() => void start('qr', { reset: true })}
        />
      )}

      {phase === 'success' && <SuccessPanel status={status} linkedNumber={linkedNumber} />}

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
      <p className="text-sm" style={{ color: 'var(--color-ink-muted)', lineHeight: 1.55 }}>
        Link this machine to your phone&apos;s WhatsApp. Credentials are stored
        locally in the orchestrator&apos;s <code>store/auth/</code> directory —
        never sent anywhere.
      </p>
    </div>
  )
}

const SCAN_STEPS = [
  'Open WhatsApp on your phone.',
  'Go to Settings → Linked Devices → Link a Device.',
  'Point your camera at the QR code.'
]

function IdlePanel({
  orchestratorRoot,
  onStart
}: {
  orchestratorRoot: string | null
  onStart: () => void
}) {
  return (
    <>
      <div className="flex items-start gap-4 mb-5">
        <Mascot state="idle" size={84} />
        <div className="flex-1">
          <h3 className="text-base font-semibold mb-1" style={{ color: 'var(--color-ink)' }}>
            Ready to pair
          </h3>
          <p className="text-xs mb-2" style={{ color: 'var(--color-ink-muted)', lineHeight: 1.55 }}>
            Click <strong>Start pairing</strong> and a QR code appears here. On
            your phone: WhatsApp → Settings → Linked Devices → Link a Device →
            scan it. Usually 10–30 seconds. Prefer not to scan? You can link
            with a phone number on the next screen.
          </p>
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
    </>
  )
}

function ScanPanel({
  method,
  qrDataUrl,
  pairingCode,
  status,
  lines,
  phone,
  showPhoneEntry,
  onPhoneChange,
  onTogglePhoneEntry,
  onGetCode,
  onBackToQr,
  onCancel
}: {
  method: Method
  qrDataUrl: string | null
  pairingCode: string | null
  status: string
  lines: string[]
  phone: string
  showPhoneEntry: boolean
  onPhoneChange: (v: string) => void
  onTogglePhoneEntry: () => void
  onGetCode: () => void
  onBackToQr: () => void
  onCancel: () => void
}) {
  const phoneValid = phone.replace(/[^\d]/g, '').length >= 8

  return (
    <>
      {method === 'qr' ? (
        <div className="flex items-start gap-5 mb-4">
          <div
            className="panel-elevated flex items-center justify-center flex-shrink-0"
            style={{ width: 220, height: 220, padding: 14, borderRadius: 'var(--radius-lg)' }}
          >
            {qrDataUrl ? (
              <img
                src={qrDataUrl}
                alt="WhatsApp pairing QR code"
                style={{ width: '100%', height: '100%', imageRendering: 'pixelated' }}
              />
            ) : (
              <div className="text-sm text-center px-4" style={{ color: 'var(--color-ink-muted)' }}>
                {status === '' ? 'Starting…' : 'Waiting for QR…'}
              </div>
            )}
          </div>
          <div className="flex-1 min-w-0">
            <ol className="text-xs space-y-1.5 mb-2" style={{ color: 'var(--color-ink-muted)' }}>
              {SCAN_STEPS.map((s, i) => (
                <li key={i}>
                  <strong style={{ color: 'var(--color-ink)' }}>{i + 1}.</strong> {s}
                </li>
              ))}
            </ol>
            <p className="text-[11px]" style={{ color: 'var(--color-ink-dim)' }}>
              The QR refreshes automatically — just scan whatever is showing.
            </p>
          </div>
        </div>
      ) : (
        <PairingCodePanel pairingCode={pairingCode} onBackToQr={onBackToQr} />
      )}

      <div className="text-xs flex items-center gap-2 mb-4" style={{ color: 'var(--color-ink-muted)' }}>
        <span
          className="w-2 h-2 rounded-full"
          style={{
            background:
              method === 'qr'
                ? qrDataUrl
                  ? 'var(--color-accent)'
                  : 'var(--color-ink-dim)'
                : pairingCode
                  ? 'var(--color-accent)'
                  : 'var(--color-ink-dim)'
          }}
        />
        {status.startsWith('pairing_code:')
          ? 'Waiting for you to enter the code on your phone…'
          : method === 'qr'
            ? qrDataUrl
              ? 'Waiting for you to scan…'
              : 'connecting…'
            : 'requesting code…'}
      </div>

      {/* QR mode: offer the phone-number alternative inline. */}
      {method === 'qr' && (
        <div className="mb-4">
          {!showPhoneEntry ? (
            <button
              type="button"
              onClick={onTogglePhoneEntry}
              className="text-xs underline"
              style={{ color: 'var(--color-ink-muted)' }}
            >
              Can&apos;t scan? Link with a phone number instead
            </button>
          ) : (
            <div className="panel px-4 py-3" style={{ borderRadius: 'var(--radius-md)' }}>
              <p className="text-xs mb-2" style={{ color: 'var(--color-ink)', lineHeight: 1.5 }}>
                Enter the phone number for this WhatsApp account (digits only,
                with country code — e.g. <code>27821234567</code>).
              </p>
              <div className="flex items-center gap-2">
                <input
                  type="tel"
                  inputMode="numeric"
                  value={phone}
                  onChange={(e) => onPhoneChange(e.target.value)}
                  placeholder="27821234567"
                  className="panel px-3 py-2 text-sm font-mono flex-1"
                  style={{ color: 'var(--color-ink)', background: 'var(--color-bg-input)' }}
                />
                <Button variant="primary" size="sm" onClick={onGetCode} disabled={!phoneValid}>
                  Get code
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      <details className="mb-4">
        <summary className="text-xs cursor-pointer mb-2" style={{ color: 'var(--color-ink-muted)' }}>
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

function PairingCodePanel({
  pairingCode,
  onBackToQr
}: {
  pairingCode: string | null
  onBackToQr: () => void
}) {
  // Group the 8-char code as XXXX-XXXX for readability (WhatsApp shows it
  // grouped on the phone too).
  const grouped =
    pairingCode && pairingCode.length === 8
      ? `${pairingCode.slice(0, 4)}-${pairingCode.slice(4)}`
      : pairingCode

  return (
    <div className="panel-elevated px-5 py-4 mb-4" style={{ borderRadius: 'var(--radius-lg)' }}>
      <p className="text-xs mb-2" style={{ color: 'var(--color-ink-muted)' }}>
        On your phone: WhatsApp → Settings → Linked Devices → Link a Device →
        <strong style={{ color: 'var(--color-ink)' }}> Link with phone number</strong>, then enter:
      </p>
      <div
        className="text-3xl font-mono font-semibold tracking-widest mb-3"
        style={{ color: 'var(--color-ink)' }}
      >
        {grouped ?? 'requesting…'}
      </div>
      <div
        className="flex items-start gap-2 px-3 py-2 rounded"
        style={{ background: 'var(--color-warning-bg)' }}
      >
        <span aria-hidden style={{ color: 'var(--color-warning)' }}>
          ⚠
        </span>
        <p className="text-[11px]" style={{ color: 'var(--color-ink)', lineHeight: 1.5 }}>
          Didn&apos;t get a prompt on your phone? Some devices don&apos;t show
          it.{' '}
          <button
            type="button"
            onClick={onBackToQr}
            className="underline font-medium"
            style={{ color: 'var(--color-ink)' }}
          >
            Scan the QR instead
          </button>{' '}
          — it&apos;s the more reliable path.
        </p>
      </div>
    </div>
  )
}

/** Map a `failed:<reason>` status to friendly, actionable copy. */
function failureCopy(status: string, method: Method): string {
  const reason = status.startsWith('failed:') ? status.slice('failed:'.length) : ''
  switch (reason) {
    case 'qr_timeout':
      return 'The QR code expired — they refresh for security. Start again to get a fresh one.'
    case 'pairing_code_timeout':
    case 'timeout':
      return method === 'pairing-code'
        ? "We didn't get confirmation from your phone. Re-enter the code, or scan the QR instead."
        : "We didn't get confirmation from your phone. Try again, or link with a phone number."
    case 'logged_out':
      return 'That device was logged out of WhatsApp. Try again to re-link it.'
    case '':
      return 'Pairing didn’t complete. Try again.'
    default:
      return `Pairing failed (${reason}). Try again.`
  }
}

function FailedPanel({
  method,
  status,
  error,
  lines,
  onRetry,
  onBackToQr
}: {
  method: Method
  status: string
  error: string | null
  lines: string[]
  onRetry: () => void
  onBackToQr: () => void
}) {
  return (
    <>
      <div className="flex items-start gap-4 mb-4">
        <Mascot state="idle" size={72} />
        <div className="flex-1">
          <h3 className="text-base font-semibold mb-1" style={{ color: 'var(--color-ink)' }}>
            Pairing didn&apos;t finish
          </h3>
          <p className="text-sm" style={{ color: 'var(--color-ink-muted)', lineHeight: 1.55 }}>
            {error ?? failureCopy(status, method)}
          </p>
        </div>
      </div>

      <div className="flex items-center gap-3 mb-4">
        <Button variant="accent" onClick={onRetry}>
          Try again
        </Button>
        {method === 'pairing-code' && (
          <Button variant="ghost" onClick={onBackToQr}>
            Scan the QR instead
          </Button>
        )}
      </div>

      <details className="mb-2">
        <summary className="text-xs cursor-pointer mb-2" style={{ color: 'var(--color-ink-muted)' }}>
          Show auth script output
        </summary>
        <LogViewer lines={lines} maxHeight={200} empty="No output yet…" />
      </details>
    </>
  )
}

function SuccessPanel({ status, linkedNumber }: { status: string; linkedNumber: string | null }) {
  const already = status === 'already_authenticated'
  return (
    <div className="flex items-center gap-4 mb-5">
      <Mascot state="success" size={72} />
      <div className="flex-1">
        <h3 className="text-base font-semibold mb-1" style={{ color: 'var(--color-ink)' }}>
          {already ? 'Already paired' : 'Linked'}
        </h3>
        <p className="text-sm" style={{ color: 'var(--color-ink-muted)' }}>
          {already
            ? 'This machine was already paired with WhatsApp. Nothing to do here.'
            : linkedNumber
              ? `WhatsApp linked as +${linkedNumber}. Credentials saved locally — move on to install the background service.`
              : 'WhatsApp is linked. Credentials saved to the orchestrator. Move on to install the background service.'}
        </p>
      </div>
    </div>
  )
}

function Footer({ onBack, primary }: { onBack: () => void; primary: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 mt-auto pt-6">
      <Button variant="ghost" onClick={onBack}>
        Back
      </Button>
      <div className="flex items-center gap-3">{primary}</div>
    </div>
  )
}
