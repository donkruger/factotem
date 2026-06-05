import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Button } from '../components/Button'
import { CommandBlock } from '../components/CommandBlock'
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

type ElectronApi = NonNullable<ReturnType<typeof useElectronAPI>>

/**
 * CredentialsStep — data-driven credential collection.
 *
 * Reads the chosen provider's `auth_kind` from setup-state →
 * `provider.protocol` → registry entry, then branches:
 *
 *   'api-key' — paste/test/register an API key against models_endpoint.
 *               When the entry also declares `subscription_auth` (Anthropic),
 *               an "API key vs Claude subscription" choice renders first.
 *   'none'    — local provider (Ollama, vLLM). Probe + auto-advance.
 *   'oauth'   — pure-OAuth providers (none today). Stub.
 *
 * Operator-facing copy comes from the registry so one component renders
 * every provider. See docs/PROVIDER_PLAYBOOK.md § 4.2.
 */
export function CredentialsStep({ onNext, onJump, onBack }: Props) {
  const api = useElectronAPI()
  const [registry, setRegistry] = useState<ProviderRegistry | null>(null)
  const [protocol, setProtocol] = useState<string>('anthropic')
  const [orchestratorRoot, setOrchestratorRoot] = useState<string | null>(null)
  const [platform, setPlatform] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  useEffect(() => {
    if (!api) return
    void (async () => {
      try {
        const env = await api.env.check()
        setOrchestratorRoot(env.orchestratorRoot)
        setPlatform(env.platform)
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

  // Branch advancement: in add-agent mode (ProviderStep left a
  // pending-credential-agent-id flag), the next stop is PairingChoiceStep.
  // First-run installs have no flag and fall through to STEPS (→ Mounts).
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
    // Anthropic (and any provider that declares a subscription option) gets
    // the API-key vs subscription choice. Everyone else: the plain key form.
    if (entry.subscription_auth) {
      return (
        <AnthropicAuthBranch
          protocol={protocol}
          entry={entry}
          orchestratorRoot={orchestratorRoot}
          platform={platform}
          onNext={dispatchNext}
          onBack={onBack}
        />
      )
    }
    return (
      <BranchShell title={`Connect your ${entry.name} account`} tagline={entry.tagline}>
        <ApiKeyForm
          protocol={protocol}
          entry={entry}
          orchestratorRoot={orchestratorRoot}
          onNext={dispatchNext}
          onBack={onBack}
        />
      </BranchShell>
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
  // OAuth — stub (no provider uses this today; Anthropic is api-key).
  return (
    <SimpleError
      title={`${entry.name} sign-in isn't supported yet`}
      message={`${entry.name} requires OAuth. We haven't built that flow yet. Pick a different provider for now and we'll wire ${entry.name} up in a future release.`}
      onBack={onBack}
    />
  )
}

// --- Shared shell + state helper ------------------------------------------

function BranchShell({
  title,
  tagline,
  children
}: {
  title: string
  tagline: string
  children: ReactNode
}) {
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
          {title}
        </h2>
        <p className="text-sm" style={{ color: 'var(--color-ink-muted)', lineHeight: 1.55 }}>
          {tagline}
        </p>
      </div>
      {children}
    </div>
  )
}

/**
 * Stamp the chosen provider + credential_id on the target agent (the
 * pending one in add-mode, else the default) and mark the step complete.
 * `data` keys are merged into setup-state.data (the IPC patch merges), so
 * the `__pending_*` hand-off flags survive for PairingChoiceStep.
 */
async function persistCredentialChoice(
  api: ElectronApi,
  opts: {
    protocol: string
    entry: ProviderRegistryEntry
    data?: Record<string, unknown>
  }
): Promise<void> {
  const state: SetupState | null = await api.state.read()
  if (!state) return
  const pendingId = state.data['__pending_credential_agent_id'] as string | undefined
  const agents = state.agents.map((a) => {
    const isTarget = pendingId ? a.id === pendingId : a.is_default
    return isTarget
      ? {
          ...a,
          provider: {
            ...a.provider,
            protocol: opts.protocol,
            model: opts.entry.default_model,
            credential_id: opts.entry.onecli?.name ?? null,
            base_url: opts.entry.capabilities.local ? opts.entry.base_url : null
          }
        }
      : a
  })
  await api.state.patch({
    agents,
    provider_default: agents.find((a) => a.is_default)?.provider,
    completedSteps: Array.from(new Set([...state.completedSteps, 'credentials'])),
    ...(opts.data ? { data: opts.data } : {})
  })
}

// --- Anthropic: API key vs subscription choice ----------------------------

type CredMethod = 'api-key' | 'subscription'

function AnthropicAuthBranch({
  protocol,
  entry,
  orchestratorRoot,
  platform,
  onNext,
  onBack
}: {
  protocol: string
  entry: ProviderRegistryEntry
  orchestratorRoot: string | null
  platform: string | null
  onNext: () => void
  onBack: () => void
}) {
  const api = useElectronAPI()
  const [method, setMethod] = useState<CredMethod>('api-key')

  // Pre-select whichever method the operator chose on a previous run.
  useEffect(() => {
    if (!api) return
    void (async () => {
      const s = await api.state.read()
      if ((s?.data['anthropic_auth_mode'] as string | undefined) === 'subscription') {
        setMethod('subscription')
      }
    })()
  }, [api])

  return (
    <BranchShell title={`Connect your ${entry.name} account`} tagline={entry.tagline}>
      <div className="flex flex-col gap-2.5 mb-5">
        <MethodCard
          name="cred-method"
          value="api-key"
          active={method === 'api-key'}
          onSelect={() => setMethod('api-key')}
          title="API key"
          badge="Recommended"
          detail="Billed per token from the Anthropic Console. Most reliable for an always-on agent — keys don't expire or rotate."
        />
        <MethodCard
          name="cred-method"
          value="subscription"
          active={method === 'subscription'}
          onSelect={() => setMethod('subscription')}
          title={entry.subscription_auth?.label ?? 'Use my Claude subscription'}
          detail={entry.subscription_auth?.tagline ?? ''}
        />
      </div>

      {method === 'api-key' ? (
        <ApiKeyForm
          protocol={protocol}
          entry={entry}
          orchestratorRoot={orchestratorRoot}
          onNext={onNext}
          onBack={onBack}
          authModeData={{ anthropic_auth_mode: 'api-key' }}
        />
      ) : (
        <SubscriptionForm
          protocol={protocol}
          entry={entry}
          orchestratorRoot={orchestratorRoot}
          platform={platform}
          onNext={onNext}
          onBack={onBack}
        />
      )}
    </BranchShell>
  )
}

function MethodCard({
  name,
  value,
  active,
  onSelect,
  title,
  detail,
  badge,
  disabled
}: {
  name: string
  value: string
  active: boolean
  onSelect: () => void
  title: string
  detail: string
  badge?: string
  disabled?: boolean
}) {
  return (
    <label
      className="panel panel-hover flex items-start gap-3 px-5 py-4 cursor-pointer"
      style={
        active
          ? { borderColor: 'var(--color-ink)', outline: '2px solid var(--color-ink)', outlineOffset: '-2px' }
          : {}
      }
    >
      <input
        type="radio"
        name={name}
        value={value}
        checked={active}
        onChange={onSelect}
        disabled={disabled}
        className="mt-0.5"
      />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-medium" style={{ color: 'var(--color-ink)' }}>
            {title}
          </span>
          {badge && (
            <span
              className="text-[10px] uppercase tracking-wider font-semibold px-1.5 py-0.5 rounded"
              style={{ color: 'var(--color-accent)', background: 'var(--color-accent-soft)' }}
            >
              {badge}
            </span>
          )}
        </div>
        {detail && (
          <div className="text-xs mt-0.5" style={{ color: 'var(--color-ink-muted)', lineHeight: 1.5 }}>
            {detail}
          </div>
        )}
      </div>
    </label>
  )
}

// --- API-key form (body only; rendered inside a BranchShell) --------------

type Phase = 'enter' | 'testing' | 'registering' | 'done' | 'error'

function ApiKeyForm({
  protocol,
  entry,
  orchestratorRoot,
  onNext,
  onBack,
  authModeData
}: {
  protocol: string
  entry: ProviderRegistryEntry
  orchestratorRoot: string | null
  onNext: () => void
  onBack: () => void
  /** When set, merged into setup-state.data on success (e.g. auth-mode marker). */
  authModeData?: Record<string, unknown>
}) {
  const api = useElectronAPI()
  const [apiKey, setApiKey] = useState('')
  const [phase, setPhase] = useState<Phase>('enter')
  const [message, setMessage] = useState<string | null>(null)
  const [modelCount, setModelCount] = useState<number | null>(null)

  // Auto-advance 800ms after successful registration.
  useEffect(() => {
    if (phase !== 'done') return
    const t = setTimeout(onNext, 800)
    return () => clearTimeout(t)
  }, [phase, onNext])

  const trimmed = apiKey.trim()
  const formatHintMatches = useMemo(() => {
    if (!entry.key_format_hint) return true
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
      const probe = await api.providers.probeKey(protocol, trimmed, orchestratorRoot)
      if (!probe.ok) {
        setPhase('error')
        setMessage(probe.message)
        return
      }
      setModelCount(probe.modelCount ?? null)
      setMessage(probe.message)

      // Probe succeeded — register the credential (update-or-create so a
      // re-run/rotation actually overwrites an existing key).
      setPhase('registering')
      const reg = await api.providers.updateCredential(protocol, trimmed, orchestratorRoot)
      if (!reg.success) {
        setPhase('error')
        setMessage(reg.error ?? 'Failed to register the credential with OneCLI.')
        return
      }

      await persistCredentialChoice(api, { protocol, entry, data: authModeData })
      setPhase('done')
    } catch (err) {
      setPhase('error')
      setMessage((err as Error).message)
    }
  }

  return (
    <>
      {entry.key_signup_url && (
        <div className="panel px-5 py-4 mb-4">
          <p className="text-sm mb-3" style={{ color: 'var(--color-ink)', lineHeight: 1.5 }}>
            You&apos;ll need an API key from {entry.name}.
            {entry.cost_hint && (
              <span style={{ color: 'var(--color-ink-muted)' }}> {entry.cost_hint}.</span>
            )}
          </p>
          <Button variant="ghost" onClick={() => api?.shell.openExternal(entry.key_signup_url ?? '')}>
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
            borderColor: phase === 'error' ? 'var(--color-danger)' : undefined
          }}
          disabled={phase === 'testing' || phase === 'registering' || phase === 'done'}
        />
        {entry.key_format_hint && (
          <span className="text-[11px] mt-0.5" style={{ color: 'var(--color-ink-muted)' }}>
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
        <p className="text-sm mb-3" style={{ color: 'var(--color-ink)' }}>
          ✓ {message}
        </p>
      )}
      {(phase === 'testing' || phase === 'registering') && (
        <p className="text-sm mb-3" style={{ color: 'var(--color-ink-muted)' }}>
          {phase === 'testing'
            ? `Testing connection to ${entry.name}…`
            : 'Registering credential with OneCLI…'}
        </p>
      )}
      {!formatHintMatches && phase === 'enter' && trimmed.length > 5 && (
        <p className="text-xs mb-3" style={{ color: 'var(--color-warning)' }}>
          Heads up — that doesn&apos;t look like a typical {entry.name} key. We&apos;ll still test it.
        </p>
      )}

      <div className="flex gap-3 justify-end mt-auto pt-4">
        <Button variant="ghost" onClick={onBack} disabled={phase === 'testing' || phase === 'registering'}>
          Back
        </Button>
        <Button
          variant="primary"
          onClick={handleTest}
          disabled={!trimmed || phase === 'testing' || phase === 'registering' || phase === 'done'}
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
          <p>
            Models found via {entry.models_endpoint.split('/').slice(2, 4).join('/')}: {modelCount}
          </p>
        )}
      </div>
    </>
  )
}

// --- Subscription form (body only) ----------------------------------------

type SubSource = 'setup-token' | 'keychain'

function SubscriptionForm({
  protocol,
  entry,
  orchestratorRoot,
  platform,
  onNext,
  onBack
}: {
  protocol: string
  entry: ProviderRegistryEntry
  orchestratorRoot: string | null
  platform: string | null
  onNext: () => void
  onBack: () => void
}) {
  const api = useElectronAPI()
  const sub = entry.subscription_auth
  const keychainOffered =
    platform === 'darwin' && !!sub?.supports_keychain_rotation
  const [source, setSource] = useState<SubSource>('setup-token')
  const [token, setToken] = useState('')
  const [phase, setPhase] = useState<Phase>('enter')
  const [message, setMessage] = useState<string | null>(null)

  useEffect(() => {
    if (phase !== 'done') return
    const t = setTimeout(onNext, 800)
    return () => clearTimeout(t)
  }, [phase, onNext])

  const trimmed = token.trim()
  const tokenLooksValid = trimmed.startsWith('sk-ant-oat')

  async function handlePasteToken() {
    if (!api || !sub) return
    setMessage(null)
    try {
      // Register the token FIRST — the proxy probe validates whatever
      // OneCLI currently holds (there's no way to validate an oat token
      // except through the configured proxy with the secret in place).
      setPhase('registering')
      const reg = await api.providers.updateCredential(protocol, trimmed, orchestratorRoot)
      if (!reg.success) {
        setPhase('error')
        setMessage(reg.error ?? 'Failed to register the token with OneCLI.')
        return
      }
      setPhase('testing')
      const probe = await api.providers.probeSubscription(protocol, trimmed, orchestratorRoot)
      if (!probe.ok) {
        setPhase('error')
        setMessage(probe.message)
        return
      }
      await persistCredentialChoice(api, {
        protocol,
        entry,
        data: { anthropic_auth_mode: 'subscription', anthropic_token_source: 'setup-token' }
      })
      setMessage(probe.message)
      setPhase('done')
    } catch (err) {
      setPhase('error')
      setMessage((err as Error).message)
    }
  }

  async function handleEnableKeychain() {
    if (!api) return
    setMessage(null)
    setPhase('registering')
    try {
      const r = await api.auth.setMode('oauth-workaround', orchestratorRoot)
      if (!r.success) {
        setPhase('error')
        setMessage(r.error ?? 'Failed to enable keychain auto-rotation.')
        return
      }
      await persistCredentialChoice(api, {
        protocol,
        entry,
        data: { anthropic_auth_mode: 'subscription', anthropic_token_source: 'keychain-watcher' }
      })
      setMessage('Keychain auto-rotation enabled. NanoClaw will track your Claude Code login.')
      setPhase('done')
    } catch (err) {
      setPhase('error')
      setMessage((err as Error).message)
    }
  }

  const busy = phase === 'testing' || phase === 'registering'

  return (
    <>
      {keychainOffered && (
        <div className="flex flex-col gap-2.5 mb-4">
          <MethodCard
            name="sub-source"
            value="setup-token"
            active={source === 'setup-token'}
            onSelect={() => {
              setSource('setup-token')
              if (phase === 'error') setPhase('enter')
            }}
            title="Paste a long-lived token"
            badge="Recommended"
            detail="Run one command, paste the token. Works anywhere; valid ~1 year."
            disabled={busy}
          />
          <MethodCard
            name="sub-source"
            value="keychain"
            active={source === 'keychain'}
            onSelect={() => {
              setSource('keychain')
              if (phase === 'error') setPhase('enter')
            }}
            title="Auto-rotate from Claude Code on this Mac"
            detail="Tracks the token in your macOS keychain and refreshes it automatically. macOS only; requires Claude Code logged in on this machine, and is less reliable when you also use Claude Code interactively."
            disabled={busy}
          />
        </div>
      )}

      {source === 'setup-token' && (
        <>
          <p className="text-sm mb-1" style={{ color: 'var(--color-ink)', lineHeight: 1.5 }}>
            Run this in a terminal, then paste the token it prints:
          </p>
          <CommandBlock command={sub?.setup_command ?? 'claude setup-token'} />
          <label className="flex flex-col gap-1 mb-2">
            <span
              className="text-xs uppercase tracking-wider font-semibold"
              style={{ color: 'var(--color-ink-muted)' }}
            >
              Subscription token
            </span>
            <input
              type="password"
              value={token}
              onChange={(e) => {
                setToken(e.target.value)
                if (phase === 'error') setPhase('enter')
              }}
              placeholder={`Paste your token (${(sub?.token_format_hint ?? 'sk-ant-oat…').toLowerCase()})`}
              className="panel px-3 py-2 text-sm font-mono"
              style={{
                color: 'var(--color-ink)',
                background: 'var(--color-bg-input)',
                borderColor: phase === 'error' ? 'var(--color-danger)' : undefined
              }}
              disabled={busy || phase === 'done'}
            />
          </label>
          {sub?.docs_note && (
            <p className="text-[11px] mb-3" style={{ color: 'var(--color-ink-muted)', lineHeight: 1.5 }}>
              {sub.docs_note}
            </p>
          )}
        </>
      )}

      {source === 'keychain' && (
        <div className="panel px-5 py-4 mb-3">
          <p className="text-sm mb-2" style={{ color: 'var(--color-ink)', lineHeight: 1.5 }}>
            NanoClaw will read your Claude Code login from the macOS keychain and keep OneCLI in
            sync via a background watcher. Make sure you&apos;ve run <code>claude</code> and logged
            in on this Mac first.
          </p>
          <p className="text-[11px]" style={{ color: 'var(--color-warning)', lineHeight: 1.5 }}>
            Heads up: a single subscription token shared across several Claude Code sessions can be
            invalidated by the others. The pasted long-lived token above is steadier.
          </p>
        </div>
      )}

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
        <p className="text-sm mb-3" style={{ color: 'var(--color-ink)' }}>
          ✓ {message}
        </p>
      )}
      {busy && (
        <p className="text-sm mb-3" style={{ color: 'var(--color-ink-muted)' }}>
          {phase === 'registering' ? 'Registering with OneCLI…' : 'Verifying with Anthropic…'}
        </p>
      )}

      <div className="flex gap-3 justify-end mt-auto pt-4">
        <Button variant="ghost" onClick={onBack} disabled={busy}>
          Back
        </Button>
        {source === 'setup-token' ? (
          <Button
            variant="primary"
            onClick={handlePasteToken}
            disabled={!tokenLooksValid || busy || phase === 'done'}
          >
            {busy ? 'Working…' : phase === 'done' ? 'Continuing…' : 'Connect subscription'}
          </Button>
        ) : (
          <Button variant="primary" onClick={handleEnableKeychain} disabled={busy || phase === 'done'}>
            {busy ? 'Working…' : phase === 'done' ? 'Continuing…' : 'Enable auto-rotation'}
          </Button>
        )}
      </div>
    </>
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
        <p className="text-sm" style={{ color: 'var(--color-ink-muted)', lineHeight: 1.55 }}>
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
          <p className="text-sm mb-3" style={{ color: 'var(--color-ink)', lineHeight: 1.5 }}>
            {message ?? `Couldn't reach ${entry.name} at ${entry.base_url}.`}
          </p>
          <p className="text-xs mb-3" style={{ color: 'var(--color-ink-muted)' }}>
            Install {entry.name}, start the daemon, then come back.
          </p>
          <Button variant="ghost" onClick={() => api?.shell.openExternal(`https://ollama.com/download`)}>
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
      <p className="text-sm mb-6" style={{ color: 'var(--color-ink-muted)', lineHeight: 1.55 }}>
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
