import { useEffect, useState, type FormEvent } from 'react'
import { Button } from '../components/Button'
import { CommandBlock } from '../components/CommandBlock'
import { useElectronAPI } from '../hooks/useElectronAPI'
import type { OneCLIProbe } from '@shared/types'

interface Props {
  onNext: () => void
  onBack: () => void
}

const ONECLI_GATEWAY_URL = 'http://127.0.0.1:10254'
const ONECLI_INSTALL_CMD =
  'curl -fsSL onecli.sh/install | sh && curl -fsSL onecli.sh/cli/install | sh'
const ANTHROPIC_CONSOLE_URL = 'https://console.anthropic.com/settings/keys'

// Step 03 — Configure OneCLI.
//
// Rebuilt with phased UX. Each phase shows only what the operator needs
// to act on next, with explicit guidance for getting from one phase to
// the next. No silent disabled buttons, no "go figure it out" copy.
//
// Phase 1 — Install            (if !installed)
// Phase 2 — Start gateway       (if installed but gateway not responding)
// Phase 3 — Get OneCLI key      (if gateway up but !authenticated)
// Phase 4 — Register Anthropic  (if authenticated but no Anthropic secret)
// Phase 5 — Done                (everything green)
type Phase = 'install' | 'start' | 'auth' | 'secret' | 'done' | 'loading'

function phaseFor(probe: OneCLIProbe | null): Phase {
  if (!probe) return 'loading'
  if (!probe.installed) return 'install'
  if (!probe.gatewayUp) return 'start'
  if (!probe.authenticated) return 'auth'
  if (!probe.anthropicSecretRegistered) return 'secret'
  return 'done'
}

export function OneCLIStep({ onNext, onBack }: Props) {
  const api = useElectronAPI()
  const [probe, setProbe] = useState<OneCLIProbe | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [ocKey, setOcKey] = useState('')
  const [anthropicKey, setAnthropicKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function reprobe() {
    if (!api) return
    setRefreshing(true)
    setError(null)
    try {
      const p = await api.onecli.probe()
      setProbe(p)
      if (p.installed && p.gatewayUp && p.authenticated && p.anthropicSecretRegistered) {
        await api.state.patch({ data: { onecli_configured: true } })
      }
    } finally {
      setRefreshing(false)
    }
  }

  useEffect(() => {
    if (!api) return
    void reprobe()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api])

  async function handleAuth(e: FormEvent) {
    e.preventDefault()
    if (!api || !ocKey.startsWith('oc_')) {
      setError('OneCLI keys start with oc_ — paste the one from the dashboard.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const r = await api.onecli.authenticate(ocKey.trim())
      if (!r.success) {
        setError(r.error ?? 'Authentication failed.')
        return
      }
      setOcKey('')
      await reprobe()
    } finally {
      setBusy(false)
    }
  }

  async function handleSecret(e: FormEvent) {
    e.preventDefault()
    if (!api || !anthropicKey.startsWith('sk-ant-')) {
      setError('Anthropic keys start with sk-ant-. Generate one at console.anthropic.com.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const r = await api.onecli.registerAnthropic(anthropicKey.trim())
      if (!r.success) {
        setError(r.error ?? 'Secret registration failed.')
        return
      }
      setAnthropicKey('')
      await reprobe()
    } finally {
      setBusy(false)
    }
  }

  const phase = phaseFor(probe)

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
          Configure OneCLI
        </h2>
        <p
          className="text-sm"
          style={{ color: 'var(--color-ink-muted)', lineHeight: 1.55 }}
        >
          OneCLI is a small daemon that holds your Anthropic credentials.
          The orchestrator never sees the key directly — it asks OneCLI
          to inject the secret into each request at runtime.
        </p>
      </div>

      <StatusStrip probe={probe} />

      {/* Phase-specific body */}
      {phase === 'loading' && (
        <div className="text-sm text-center py-8" style={{ color: 'var(--color-ink-muted)' }}>
          Checking OneCLI…
        </div>
      )}

      {phase === 'install' && <PhaseInstall api={api} />}
      {phase === 'start' && <PhaseStart api={api} />}
      {phase === 'auth' && (
        <PhaseAuth
          api={api}
          ocKey={ocKey}
          setOcKey={setOcKey}
          busy={busy}
          onSubmit={handleAuth}
        />
      )}
      {phase === 'secret' && (
        <PhaseSecret
          api={api}
          anthropicKey={anthropicKey}
          setAnthropicKey={setAnthropicKey}
          busy={busy}
          onSubmit={handleSecret}
        />
      )}
      {phase === 'done' && (
        <div
          className="px-4 py-3 mb-5 rounded-md text-sm"
          style={{ background: 'var(--color-success-bg)', color: 'var(--color-success)' }}
        >
          OneCLI is fully configured. The Anthropic credential is registered and ready
          to be injected into agent containers at request time.
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
          <Button variant="ghost" onClick={reprobe} loading={refreshing}>
            Re-check
          </Button>
          <Button onClick={onNext} disabled={phase !== 'done'}>
            Continue
          </Button>
        </div>
      </div>
    </div>
  )
}

// ─── Status strip ──────────────────────────────────────────────────────────

function StatusStrip({ probe }: { probe: OneCLIProbe | null }) {
  const rows: Array<{ label: string; ok: boolean | null; detail?: string }> = [
    {
      label: 'OneCLI installed',
      ok: probe?.installed ?? null,
      detail: probe?.version
    },
    {
      label: 'Gateway running',
      ok: probe?.gatewayUp ?? null,
      detail: probe?.gatewayUp ? ONECLI_GATEWAY_URL : undefined
    },
    {
      label: 'CLI authenticated',
      ok: probe?.authenticated ?? null
    },
    {
      label: 'Anthropic credential registered',
      ok: probe?.anthropicSecretRegistered ?? null
    }
  ]
  return (
    <div
      className="panel-elevated mb-5 px-4 py-3"
      style={{ borderRadius: 'var(--radius-md)' }}
    >
      <div className="flex flex-col gap-1.5">
        {rows.map((r) => (
          <div key={r.label} className="flex items-center gap-3 text-xs">
            <span
              className="w-2 h-2 rounded-full flex-shrink-0"
              style={{
                background:
                  r.ok === null
                    ? 'var(--color-ink-dim)'
                    : r.ok
                      ? 'var(--color-success)'
                      : 'var(--color-warning)'
              }}
            />
            <span style={{ color: 'var(--color-ink)' }}>{r.label}</span>
            {r.detail && (
              <span style={{ color: 'var(--color-ink-muted)' }}>· {r.detail}</span>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── Phase 1 — Install ─────────────────────────────────────────────────────

function PhaseInstall({ api }: { api: Window['electronAPI'] | null }) {
  return (
    <div>
      <h3 className="text-base font-semibold mb-2" style={{ color: 'var(--color-ink)' }}>
        Install OneCLI
      </h3>
      <p className="text-sm mb-3" style={{ color: 'var(--color-ink-muted)', lineHeight: 1.55 }}>
        OneCLI is a one-line install. The script puts the binary at{' '}
        <code>~/.local/bin/onecli</code> and starts the gateway daemon as a
        background service.
      </p>
      <CommandBlock command={ONECLI_INSTALL_CMD} caption="Run in Terminal" />
      <p className="text-xs mt-1" style={{ color: 'var(--color-ink-dim)' }}>
        Take 30–60 seconds. When it finishes, click <strong>Re-check</strong> below.
      </p>
      <div className="text-xs mt-3" style={{ color: 'var(--color-ink-muted)' }}>
        Why we don&apos;t run it from inside the wizard: the installer sometimes
        prompts for sudo or needs interactive input. Running in your terminal
        means you see what it&apos;s doing.{' '}
        <button
          type="button"
          onClick={() => api?.shell.openExternal('https://onecli.sh')}
          className="underline hover:opacity-80"
          style={{ color: 'var(--color-accent)' }}
        >
          About OneCLI →
        </button>
      </div>
    </div>
  )
}

// ─── Phase 2 — Start gateway ───────────────────────────────────────────────

function PhaseStart({ api }: { api: Window['electronAPI'] | null }) {
  return (
    <div>
      <h3 className="text-base font-semibold mb-2" style={{ color: 'var(--color-ink)' }}>
        Start the OneCLI gateway
      </h3>
      <p className="text-sm mb-3" style={{ color: 'var(--color-ink-muted)', lineHeight: 1.55 }}>
        OneCLI is installed but the daemon isn&apos;t answering at{' '}
        <code>{ONECLI_GATEWAY_URL}</code>. Most often this means launchd
        loaded but the process exited, or the install never finished setting
        up the service.
      </p>
      <p className="text-sm mb-2" style={{ color: 'var(--color-ink)' }}>
        The fastest fix is re-running the installer — it&apos;s idempotent and
        refreshes the launchd service.
      </p>
      <CommandBlock command={ONECLI_INSTALL_CMD} caption="Re-run in Terminal" />
      <details className="mt-4">
        <summary
          className="text-xs cursor-pointer"
          style={{ color: 'var(--color-ink-muted)' }}
        >
          If that doesn&apos;t work…
        </summary>
        <div className="mt-2 text-xs" style={{ color: 'var(--color-ink-muted)', lineHeight: 1.55 }}>
          On macOS, OneCLI installs a launchd plist. Check it directly:
          <CommandBlock
            command="launchctl list | grep onecli"
            showOpenTerminal={!!api}
          />
          If you see the service listed but not running, kickstart it:
          <CommandBlock command="launchctl kickstart -k gui/$(id -u)/sh.onecli" />
          If the plist doesn&apos;t exist at all, the installer didn&apos;t finish — re-run it from above.
        </div>
      </details>
    </div>
  )
}

// ─── Phase 3 — OneCLI key + authenticate ───────────────────────────────────

function PhaseAuth({
  api,
  ocKey,
  setOcKey,
  busy,
  onSubmit
}: {
  api: Window['electronAPI'] | null
  ocKey: string
  setOcKey: (v: string) => void
  busy: boolean
  onSubmit: (e: FormEvent) => void
}) {
  return (
    <form onSubmit={onSubmit}>
      <h3 className="text-base font-semibold mb-2" style={{ color: 'var(--color-ink)' }}>
        Authenticate this machine
      </h3>
      <p className="text-sm mb-4" style={{ color: 'var(--color-ink-muted)', lineHeight: 1.55 }}>
        Open the OneCLI dashboard, sign up (or sign in), then generate an API
        key from <strong>Settings → API Keys</strong>. Paste it below.
      </p>

      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <Button
          type="button"
          variant="accent"
          onClick={() => api?.shell.openExternal(ONECLI_GATEWAY_URL)}
        >
          Open OneCLI dashboard
        </Button>
        <span className="text-xs" style={{ color: 'var(--color-ink-muted)' }}>
          opens <code>{ONECLI_GATEWAY_URL}</code> in your browser
        </span>
      </div>

      <Walkthrough
        steps={[
          'Click “Open OneCLI dashboard” above (or visit the URL in your browser).',
          'Create an account on first visit — local-only, no email needed.',
          'Navigate to Settings → API Keys.',
          'Click “Generate” to create a fresh `oc_…` key.',
          'Copy the key and paste it below.'
        ]}
      />

      <label
        className="block text-sm font-medium mb-1.5 mt-5"
        style={{ color: 'var(--color-ink)' }}
      >
        OneCLI API key
      </label>
      <input
        type="password"
        value={ocKey}
        onChange={(e) => setOcKey(e.target.value)}
        placeholder="oc_…"
        className="input-field font-mono"
        autoComplete="off"
        spellCheck={false}
      />
      <p className="text-xs mt-1.5" style={{ color: 'var(--color-ink-muted)' }}>
        Used once to authenticate the CLI on this machine. We store
        nothing — the credential lives in OneCLI&apos;s vault.
      </p>

      <div className="flex justify-end mt-4">
        <Button type="submit" loading={busy} disabled={!ocKey}>
          Authenticate
        </Button>
      </div>
    </form>
  )
}

// ─── Phase 4 — Anthropic secret ────────────────────────────────────────────

function PhaseSecret({
  api,
  anthropicKey,
  setAnthropicKey,
  busy,
  onSubmit
}: {
  api: Window['electronAPI'] | null
  anthropicKey: string
  setAnthropicKey: (v: string) => void
  busy: boolean
  onSubmit: (e: FormEvent) => void
}) {
  return (
    <form onSubmit={onSubmit}>
      <h3 className="text-base font-semibold mb-2" style={{ color: 'var(--color-ink)' }}>
        Register your Anthropic credential
      </h3>
      <p className="text-sm mb-4" style={{ color: 'var(--color-ink-muted)', lineHeight: 1.55 }}>
        OneCLI is now authenticated. The last step is to add the Anthropic API
        key it should inject when the agent makes a Claude request. It&apos;s
        stored encrypted in OneCLI&apos;s vault — never written to disk by the
        orchestrator.
      </p>

      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <Button
          type="button"
          variant="ghost"
          onClick={() => api?.shell.openExternal(ANTHROPIC_CONSOLE_URL)}
        >
          Open Anthropic console
        </Button>
        <span className="text-xs" style={{ color: 'var(--color-ink-muted)' }}>
          {ANTHROPIC_CONSOLE_URL}
        </span>
      </div>

      <Walkthrough
        steps={[
          'Open the Anthropic console (button above).',
          'Settings → API Keys → Create Key.',
          'Copy the `sk-ant-…` key.',
          'Paste it below. You can also use a subscription token (`sk-ant-oat01-…`).'
        ]}
      />

      <label
        className="block text-sm font-medium mb-1.5 mt-5"
        style={{ color: 'var(--color-ink)' }}
      >
        Anthropic API key
      </label>
      <input
        type="password"
        value={anthropicKey}
        onChange={(e) => setAnthropicKey(e.target.value)}
        placeholder="sk-ant-api… or sk-ant-oat01-…"
        className="input-field font-mono"
        autoComplete="off"
        spellCheck={false}
      />

      <div className="flex justify-end mt-4">
        <Button type="submit" loading={busy} disabled={!anthropicKey}>
          Register secret
        </Button>
      </div>
    </form>
  )
}

// ─── Walkthrough ────────────────────────────────────────────────────────────

function Walkthrough({ steps }: { steps: string[] }) {
  return (
    <ol className="flex flex-col gap-2 mt-1">
      {steps.map((s, i) => (
        <li key={i} className="flex items-start gap-3 text-sm">
          <span
            className="flex-shrink-0 w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-semibold"
            style={{
              background: 'var(--color-accent-soft)',
              color: 'var(--color-accent)'
            }}
          >
            {i + 1}
          </span>
          <span style={{ color: 'var(--color-ink)', lineHeight: 1.55 }}>{s}</span>
        </li>
      ))}
    </ol>
  )
}
