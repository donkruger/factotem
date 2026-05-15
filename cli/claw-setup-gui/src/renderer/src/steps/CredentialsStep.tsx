import { useEffect, useMemo, useState } from 'react'
import { Button } from '../components/Button'
import { useElectronAPI } from '../hooks/useElectronAPI'
import type {
  ProviderRegistry,
  ProviderRegistryEntry,
  SetupState
} from '@shared/types'
import type { StepId } from '../hooks/useWizard'

interface Props {
  onNext: () => void
  onJump: (id: StepId) => void
  onBack: () => void
}

/**
 * CredentialsStep — data-driven replacement for OneCLIStep.
 *
 * Reads the chosen provider's `auth_kind` from setup-state →
 * `provider_default.protocol` → registry entry, then branches:
 *
 *   'api-key' — render the 5-phase flow extracted from OneCLIStep
 *               (open sign-up link → paste key → test against
 *               models_endpoint → register with OneCLI → success).
 *   'none'    — local provider (Ollama, vLLM). Probe the local
 *               endpoint, auto-advance on success.
 *   'oauth'   — future. Stub "coming soon" + back button.
 *
 * Operator-facing copy comes from the registry (`name`, `tagline`,
 * `key_signup_url`, `key_format_hint`) so the same React component
 * renders Anthropic, Gemini, OpenAI, OpenRouter, etc.
 *
 * See docs/PROVIDER_PLAYBOOK.md § 4.2 (Wizard contract) and
 * docs/implementation/gemini-blueprint.md § 6.2 (Phase D — CredentialsStep).
 */
export function CredentialsStep({ onNext, onJump, onBack }: Props) {
  const api = useElectronAPI()
  const [registry, setRegistry] = useState<ProviderRegistry | null>(null)
  const [protocol, setProtocol] = useState<string>('anthropic')
  const [orchestratorRoot, setOrchestratorRoot] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  useEffect(() => {
    if (!api) return
    void (async () => {
      try {
        const env = await api.env.check()
        setOrchestratorRoot(env.orchestratorRoot)
        const [reg, state] = await Promise.all([
          api.providers.list(env.orchestratorRoot),
          api.state.read()
        ])
        setRegistry(reg)
        if (state) {
          // If ProviderStep left a pending-credential hint, the
          // credential is for the *new* agent created in add mode —
          // pick that agent's protocol. Otherwise fall back to the
          // default agent's protocol (reconfigure path).
          const pendingId = state.data['__pending_credential_agent_id'] as
            | string
            | undefined
          const pendingAgent = pendingId
            ? state.agents.find((a) => a.id === pendingId)
            : null
          const defaultAgent =
            state.agents.find((a) => a.is_default) ?? state.agents[0]
          const proto =
            pendingAgent?.provider.protocol ??
            defaultAgent?.provider.protocol ??
            state.provider_default?.protocol ??
            'anthropic'
          if (reg[proto]) setProtocol(proto)
        }
      } catch (err) {
        setLoadError((err as Error).message)
      }
    })()
  }, [api])

  const entry = registry?.[protocol]

  if (loadError) {
    return (
      <SimpleError
        title="Can't load the provider list"
        message={loadError}
        onBack={onBack}
      />
    )
  }

  if (!registry || !entry) {
    return (
      <div className="step-enter flex-1 flex items-center justify-center p-10">
        <p style={{ color: 'var(--color-ink-muted)' }}>Loading…</p>
      </div>
    )
  }

  // Branch advancement: in add-agent mode (when ProviderStep left a
  // pending-credential-agent-id hand-off flag), the next stop is the
  // PairingChoiceStep so the operator can pick shared vs. new
  // pairing for the new agent. First-run installs have no flag and
  // fall through to the linear STEPS path (→ Mounts).
  // (v1.2.1-finish-blueprint § 2.3 — Routing.)
  async function dispatchNext(): Promise<void> {
    if (!api) {
      onNext()
      return
    }
    try {
      const s = await api.state.read()
      if (s?.data['__pending_credential_agent_id']) {
        onJump('pairingChoice')
        return
      }
    } catch {
      /* fall through to onNext */
    }
    onNext()
  }

  if (entry.auth_kind === 'api-key') {
    return (
      <ApiKeyBranch
        protocol={protocol}
        entry={entry}
        orchestratorRoot={orchestratorRoot}
        onNext={dispatchNext}
        onBack={onBack}
      />
    )
  }
  if (entry.auth_kind === 'none') {
    return (
      <LocalBranch
        protocol={protocol}
        entry={entry}
        orchestratorRoot={orchestratorRoot}
        onNext={dispatchNext}
        onBack={onBack}
      />
    )
  }
  // OAuth — stub.
  return (
    <SimpleError
      title={`${entry.name} sign-in isn't supported yet`}
      message={`${entry.name} requires OAuth. We haven't built that flow yet. Pick a different provider for now and we'll wire ${entry.name} up in a future release.`}
      onBack={onBack}
    />
  )
}

// --- API-key branch -------------------------------------------------------

type Phase = 'enter' | 'testing' | 'registering' | 'done' | 'error'

function ApiKeyBranch({
  protocol,
  entry,
  orchestratorRoot,
  onNext,
  onBack
}: {
  protocol: string
  entry: ProviderRegistryEntry
  orchestratorRoot: string | null
  onNext: () => void
  onBack: () => void
}) {
  const api = useElectronAPI()
  const [apiKey, setApiKey] = useState('')
  const [phase, setPhase] = useState<Phase>('enter')
  const [message, setMessage] = useState<string | null>(null)
  const [modelCount, setModelCount] = useState<number | null>(null)

  // Auto-advance to Mounts 800ms after successful registration.
  useEffect(() => {
    if (phase !== 'done') return
    const t = setTimeout(onNext, 800)
    return () => clearTimeout(t)
  }, [phase, onNext])

  const trimmed = apiKey.trim()
  const formatHintMatches = useMemo(() => {
    if (!entry.key_format_hint) return true
    // Best-effort substring match against the hint description. Hints
    // are short ("Starts with sk-ant-") so this catches typos without
    // false-rejecting non-obvious formats.
    const m = entry.key_format_hint.match(/[`'"]?([a-zA-Z0-9_-]{3,})[`'"]?/)
    if (!m) return true
    return trimmed.toLowerCase().includes(m[1].toLowerCase())
  }, [trimmed, entry.key_format_hint])

  async function handleTest() {
    if (!api) return
    setPhase('testing')
    setMessage(null)
    setModelCount(null)
    try {
      const probe = await api.providers.probeKey(
        protocol,
        trimmed,
        orchestratorRoot
      )
      if (!probe.ok) {
        setPhase('error')
        setMessage(probe.message)
        return
      }
      setModelCount(probe.modelCount ?? null)
      setMessage(probe.message)

      // Probe succeeded — register the credential.
      setPhase('registering')
      const reg = await api.providers.createCredential(
        protocol,
        trimmed,
        orchestratorRoot
      )
      if (!reg.success) {
        setPhase('error')
        setMessage(reg.error ?? 'Failed to register the credential with OneCLI.')
        return
      }

      // Mark this step done in setup-state and stamp the credential_id
      // on the right agent — the pending one in add-mode, otherwise
      // the default agent.
      const state: SetupState | null = await api.state.read()
      if (state) {
        const pendingId = state.data['__pending_credential_agent_id'] as
          | string
          | undefined
        const agents = state.agents.map((a) => {
          const isTarget = pendingId ? a.id === pendingId : a.is_default
          return isTarget
            ? {
                ...a,
                provider: {
                  ...a.provider,
                  protocol,
                  model: entry.default_model,
                  credential_id: entry.onecli?.name ?? null,
                  base_url: entry.capabilities.local ? entry.base_url : null
                }
              }
            : a
        })
        // Keep `__pending_credential_agent_id` and `__mode` alive past
        // this step — PairingChoiceStep reads them to know which agent
        // is mid-creation and that we're in add-agent mode. They get
        // cleared by PairingChoiceStep (which is the last hand-off
        // point for new agents). In first-run mode neither flag is
        // set, so this is a no-op there.
        // (v1.2.1-finish-blueprint § 2 — wizard state lifecycle.)
        await api.state.patch({
          agents,
          provider_default: agents.find((a) => a.is_default)?.provider,
          completedSteps: Array.from(
            new Set([...state.completedSteps, 'credentials'])
          )
        })
      }
      setPhase('done')
    } catch (err) {
      setPhase('error')
      setMessage((err as Error).message)
    }
  }

  return (
    <div className="step-enter flex-1 flex flex-col px-10 py-7 max-w-2xl mx-auto w-full">
      <div className="mb-6">
        <h2
          className="text-2xl mb-1"
          style={{
            color: 'var(--color-ink)',
            letterSpacing: 'var(--tracking-display)',
            fontWeight: 600
          }}
        >
          Connect your {entry.name} account
        </h2>
        <p
          className="text-sm"
          style={{ color: 'var(--color-ink-muted)', lineHeight: 1.55 }}
        >
          {entry.tagline}
        </p>
      </div>

      {entry.key_signup_url && (
        <div className="panel px-5 py-4 mb-4">
          <p
            className="text-sm mb-3"
            style={{ color: 'var(--color-ink)', lineHeight: 1.5 }}
          >
            You&apos;ll need an API key from {entry.name}.
            {entry.cost_hint && (
              <span style={{ color: 'var(--color-ink-muted)' }}>
                {' '}
                {entry.cost_hint}.
              </span>
            )}
          </p>
          <Button
            variant="ghost"
            onClick={() =>
              api?.shell.openExternal(entry.key_signup_url ?? '')
            }
          >
            Open {entry.name} →
          </Button>
        </div>
      )}

      <label className="flex flex-col gap-1 mb-3">
        <span
          className="text-xs uppercase tracking-wider font-semibold"
          style={{ color: 'var(--color-ink-muted)' }}
        >
          API key
        </span>
        <input
          type="password"
          value={apiKey}
          onChange={(e) => {
            setApiKey(e.target.value)
            if (phase === 'error') setPhase('enter')
          }}
          placeholder={
            entry.key_format_hint
              ? `Paste your key (${entry.key_format_hint.toLowerCase()})`
              : `Paste your key from ${entry.name}`
          }
          className="panel px-3 py-2 text-sm font-mono"
          style={{
            color: 'var(--color-ink)',
            background: 'var(--color-bg-input)',
            borderColor:
              phase === 'error' ? 'var(--color-danger)' : undefined
          }}
          disabled={phase === 'testing' || phase === 'registering' || phase === 'done'}
        />
        {entry.key_format_hint && (
          <span
            className="text-[11px] mt-0.5"
            style={{ color: 'var(--color-ink-muted)' }}
          >
            {entry.key_format_hint}. We test it before continuing.
          </span>
        )}
      </label>

      {phase === 'error' && message && (
        <p
          className="text-sm mb-3 px-3 py-2 rounded"
          style={{
            color: 'var(--color-ink-on-danger)',
            background: 'var(--color-danger-bg)',
            border: '1px solid var(--color-danger)'
          }}
        >
          {message}
        </p>
      )}
      {phase === 'done' && message && (
        <p
          className="text-sm mb-3"
          style={{ color: 'var(--color-ink)' }}
        >
          ✓ {message}
        </p>
      )}
      {(phase === 'testing' || phase === 'registering') && (
        <p
          className="text-sm mb-3"
          style={{ color: 'var(--color-ink-muted)' }}
        >
          {phase === 'testing'
            ? `Testing connection to ${entry.name}…`
            : 'Registering credential with OneCLI…'}
        </p>
      )}
      {!formatHintMatches && phase === 'enter' && trimmed.length > 5 && (
        <p
          className="text-xs mb-3"
          style={{ color: 'var(--color-warning)' }}
        >
          Heads up — that doesn&apos;t look like a typical {entry.name} key.
          We&apos;ll still test it.
        </p>
      )}

      <div className="flex gap-3 justify-end mt-auto pt-4">
        <Button
          variant="ghost"
          onClick={onBack}
          disabled={phase === 'testing' || phase === 'registering'}
        >
          Back
        </Button>
        <Button
          variant="primary"
          onClick={handleTest}
          disabled={
            !trimmed ||
            phase === 'testing' ||
            phase === 'registering' ||
            phase === 'done'
          }
        >
          {phase === 'testing' || phase === 'registering'
            ? 'Working…'
            : phase === 'done'
              ? 'Continuing…'
              : 'Test connection'}
        </Button>
      </div>

      <div className="mt-4 text-[11px]" style={{ color: 'var(--color-ink-muted)' }}>
        {modelCount != null && (
          <p>Models found via {entry.models_endpoint.split('/').slice(2, 4).join('/')}: {modelCount}</p>
        )}
      </div>
    </div>
  )
}

// --- Local-provider (no auth) branch --------------------------------------

function LocalBranch({
  protocol,
  entry,
  orchestratorRoot,
  onNext,
  onBack
}: {
  protocol: string
  entry: ProviderRegistryEntry
  orchestratorRoot: string | null
  onNext: () => void
  onBack: () => void
}) {
  const api = useElectronAPI()
  const [status, setStatus] = useState<'probing' | 'found' | 'missing'>('probing')
  const [message, setMessage] = useState<string | null>(null)

  useEffect(() => {
    if (!api) return
    void (async () => {
      try {
        const r = await api.providers.probeKey(protocol, '', orchestratorRoot)
        if (r.ok) {
          setMessage(r.message)
          setStatus('found')
          // Auto-advance after a quick toast.
          setTimeout(() => {
            void (async () => {
              const state: SetupState | null = await api.state.read()
              if (state) {
                const pendingId = state.data[
                  '__pending_credential_agent_id'
                ] as string | undefined
                const agents = state.agents.map((a) => {
                  const isTarget = pendingId
                    ? a.id === pendingId
                    : a.is_default
                  return isTarget
                    ? {
                        ...a,
                        provider: {
                          ...a.provider,
                          protocol,
                          model: entry.default_model,
                          base_url: entry.base_url,
                          credential_id: null
                        }
                      }
                    : a
                })
                const data: Record<string, unknown> = { ...state.data }
                delete data['__pending_credential_agent_id']
                delete data['__mode']
                await api.state.patch({
                  agents,
                  provider_default: agents.find((a) => a.is_default)?.provider,
                  completedSteps: Array.from(
                    new Set([...state.completedSteps, 'credentials'])
                  ),
                  data
                })
              }
              onNext()
            })()
          }, 600)
        } else {
          setMessage(r.message)
          setStatus('missing')
        }
      } catch (err) {
        setMessage((err as Error).message)
        setStatus('missing')
      }
    })()
  }, [api, protocol, entry, orchestratorRoot, onNext])

  return (
    <div className="step-enter flex-1 flex flex-col px-10 py-7 max-w-2xl mx-auto w-full">
      <div className="mb-6">
        <h2
          className="text-2xl mb-1"
          style={{
            color: 'var(--color-ink)',
            letterSpacing: 'var(--tracking-display)',
            fontWeight: 600
          }}
        >
          Detecting {entry.name}
        </h2>
        <p
          className="text-sm"
          style={{ color: 'var(--color-ink-muted)', lineHeight: 1.55 }}
        >
          {entry.tagline}
        </p>
      </div>

      {status === 'probing' && (
        <p className="text-sm" style={{ color: 'var(--color-ink-muted)' }}>
          Looking for {entry.name} on this machine…
        </p>
      )}
      {status === 'found' && (
        <p className="text-sm" style={{ color: 'var(--color-ink)' }}>
          ✓ {message}
        </p>
      )}
      {status === 'missing' && (
        <div className="panel px-5 py-4">
          <p
            className="text-sm mb-3"
            style={{ color: 'var(--color-ink)', lineHeight: 1.5 }}
          >
            {message ?? `Couldn't reach ${entry.name} at ${entry.base_url}.`}
          </p>
          <p
            className="text-xs mb-3"
            style={{ color: 'var(--color-ink-muted)' }}
          >
            Install {entry.name}, start the daemon, then come back.
          </p>
          <Button
            variant="ghost"
            onClick={() =>
              api?.shell.openExternal(`https://ollama.com/download`)
            }
          >
            Install Ollama →
          </Button>
        </div>
      )}

      <div className="flex gap-3 justify-end mt-auto pt-4">
        <Button variant="ghost" onClick={onBack}>
          Back
        </Button>
        {status === 'missing' && (
          <Button variant="primary" onClick={() => location.reload()}>
            Try again
          </Button>
        )}
      </div>
    </div>
  )
}

function SimpleError({
  title,
  message,
  onBack
}: {
  title: string
  message: string
  onBack: () => void
}) {
  return (
    <div className="step-enter flex-1 flex flex-col px-10 py-7 max-w-2xl mx-auto w-full">
      <h2 className="text-2xl mb-3" style={{ color: 'var(--color-ink)', fontWeight: 600 }}>
        {title}
      </h2>
      <p
        className="text-sm mb-6"
        style={{ color: 'var(--color-ink-muted)', lineHeight: 1.55 }}
      >
        {message}
      </p>
      <div className="flex gap-3">
        <Button variant="ghost" onClick={onBack}>
          Back
        </Button>
      </div>
    </div>
  )
}
