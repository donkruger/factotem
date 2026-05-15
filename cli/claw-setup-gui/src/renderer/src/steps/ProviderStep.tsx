import { useEffect, useMemo, useState } from 'react'
import { Button } from '../components/Button'
import { useElectronAPI } from '../hooks/useElectronAPI'
import type {
  ProviderRegistry,
  ProviderRegistryEntry,
  SetupState
} from '@shared/types'

interface Props {
  onNext: () => void
  onBack: () => void
}

/**
 * ProviderStep — pick which AI provider answers this deployment's messages.
 *
 * Data-driven from `setup/providers.json`. Each entry in the registry
 * renders as one card. Anthropic is the recommended default and sits
 * top-left with a subtle outline glow. Operators pick exactly one;
 * the choice writes `provider_default` to setup-state and updates the
 * default agent's provider field.
 *
 * Subsequent providers (OpenAI, OpenRouter, Together, etc.) appear here
 * automatically as their entries land in `providers.json` — no UI
 * changes required.
 *
 * See PROVIDER_PLAYBOOK § 4.2 (Wizard contract) for the card layout.
 */
export function ProviderStep({ onNext, onBack }: Props) {
  const api = useElectronAPI()
  const [registry, setRegistry] = useState<ProviderRegistry | null>(null)
  const [selected, setSelected] = useState<string>('anthropic')
  const [orchestratorRoot, setOrchestratorRoot] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!api) return
    void (async () => {
      try {
        const env = await api.env.check()
        setOrchestratorRoot(env.orchestratorRoot)
        const reg = await api.providers.list(env.orchestratorRoot)
        setRegistry(reg)
        const existing: SetupState | null = await api.state.read()
        if (existing) {
          const isAddMode = existing.data['__mode'] === 'add-agent'
          if (isAddMode) {
            // In add mode, default-pick a provider the operator
            // doesn't already use. Picking the same provider as an
            // existing agent would be allowed but less useful as a
            // first suggestion.
            const usedProtocols = new Set(
              existing.agents.map((a) => a.provider.protocol)
            )
            const firstUnused = Object.keys(reg).find(
              (p) => !usedProtocols.has(p)
            )
            if (firstUnused) setSelected(firstUnused)
          } else {
            // Reconfigure mode: pre-select the default agent's current
            // protocol.
            const defaultAgent =
              existing.agents.find((a) => a.is_default) ??
              existing.agents[0]
            if (
              defaultAgent?.provider.protocol &&
              reg[defaultAgent.provider.protocol]
            ) {
              setSelected(defaultAgent.provider.protocol)
            }
          }
        }
      } catch (err) {
        setLoadError((err as Error).message)
      }
    })()
  }, [api])

  // Sort the registry into card order: recommended first, then other
  // cloud entries, then local entries. Stable within each bucket.
  const orderedProviders = useMemo(() => {
    if (!registry) return []
    const entries = Object.entries(registry)
    return entries.sort(([a, ea], [b, eb]) => {
      if (a === 'anthropic') return -1
      if (b === 'anthropic') return 1
      const aLocal = ea.capabilities.local
      const bLocal = eb.capabilities.local
      if (aLocal !== bLocal) return aLocal ? 1 : -1
      return ea.name.localeCompare(eb.name)
    })
  }, [registry])

  async function handleContinue() {
    if (!api || !registry) return
    const entry = registry[selected]
    if (!entry) return
    setSaving(true)
    try {
      const existing: SetupState | null = await api.state.read()
      if (!existing) {
        // Shouldn't happen — profile step runs first and seeds state.
        // Bail back to profile rather than crash.
        onBack()
        return
      }

      const provider = {
        protocol: selected,
        model: entry.default_model,
        base_url: entry.capabilities.local ? entry.base_url : null,
        credential_id: entry.onecli?.name ?? null
      }

      // PR 3 § H.5: Welcome's "Add another agent" path sets
      // data.__mode = 'add-agent'. In that mode we *append* a new
      // non-default agent rather than overwriting the default's
      // provider. The new agent's id is derived from the protocol so
      // the operator gets a stable handle without an explicit naming
      // step in this PR — naming UI lands with the dashboard's Add
      // Agent flow in PR 4.
      const isAddMode = existing.data['__mode'] === 'add-agent'
      let agents = existing.agents
      let newAgentId: string | null = null
      if (isAddMode) {
        // Avoid duplicates: if an agent on this protocol already
        // exists, treat the operator's pick as "switch to it" rather
        // than "create a second on the same protocol".
        const existingOnProtocol = agents.find(
          (a) => a.provider.protocol === selected
        )
        if (existingOnProtocol) {
          newAgentId = existingOnProtocol.id
        } else {
          const baseName = capitalise(entry.name.split(' ')[0])
          const uniqueName = ensureUniqueAgentName(baseName, agents)
          const id = slugifyAgentId(uniqueName)
          newAgentId = id
          agents = [
            ...agents,
            {
              id,
              name: uniqueName,
              persona: '',
              provider,
              memory_namespace: `agents/${id}`,
              default_trigger: `@${uniqueName}`,
              parent_agent_id: null,
              is_default: false,
              created_at: new Date().toISOString()
            }
          ]
        }
      } else {
        // Default path: patch the default agent's provider.
        agents = agents.map((a) =>
          a.is_default ? { ...a, provider } : a
        )
      }

      const defaultAgent =
        agents.find((a) => a.is_default) ?? agents[0]

      // Hand off to CredentialsStep. In add-mode the credential being
      // collected is for the new agent, not the default — record its
      // id so CredentialsStep knows what to write back.
      const data: Record<string, unknown> = { ...existing.data }
      if (isAddMode && newAgentId) {
        data['__pending_credential_agent_id'] = newAgentId
      }

      await api.state.patch({
        agents,
        provider_default: defaultAgent?.provider ?? provider,
        completedSteps: Array.from(
          new Set([...existing.completedSteps, 'provider'])
        ),
        data
      })
      onNext()
    } catch (err) {
      setLoadError((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  if (loadError) {
    return (
      <div className="step-enter flex-1 flex flex-col px-10 py-7 max-w-2xl mx-auto w-full">
        <h2
          className="text-2xl mb-3"
          style={{ color: 'var(--color-ink)', fontWeight: 600 }}
        >
          Can&apos;t load the provider list
        </h2>
        <p
          className="text-sm mb-6"
          style={{ color: 'var(--color-ink-muted)', lineHeight: 1.55 }}
        >
          {loadError}
        </p>
        <div className="flex gap-3">
          <Button variant="ghost" onClick={onBack}>
            Back
          </Button>
          <Button variant="primary" onClick={() => location.reload()}>
            Reload
          </Button>
        </div>
      </div>
    )
  }

  if (!registry) {
    return (
      <div className="step-enter flex-1 flex items-center justify-center p-10">
        <p style={{ color: 'var(--color-ink-muted)' }}>Loading providers…</p>
      </div>
    )
  }

  return (
    <div className="step-enter flex-1 flex flex-col px-10 py-7 max-w-3xl mx-auto w-full">
      <div className="mb-6">
        <h2
          className="text-2xl mb-1"
          style={{
            color: 'var(--color-ink)',
            letterSpacing: 'var(--tracking-display)',
            fontWeight: 600
          }}
        >
          Pick a model
        </h2>
        <p
          className="text-sm"
          style={{ color: 'var(--color-ink-muted)', lineHeight: 1.55 }}
        >
          Powers your default agent. You can change this any time from the
          dashboard, and you can add more agents on other providers later.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-6">
        {orderedProviders.map(([protocol, entry]) => (
          <ProviderCard
            key={protocol}
            protocol={protocol}
            entry={entry}
            active={selected === protocol}
            onSelect={() => setSelected(protocol)}
          />
        ))}
      </div>

      <div className="flex gap-3 justify-end mt-auto pt-4">
        <Button variant="ghost" onClick={onBack} disabled={saving}>
          Back
        </Button>
        <Button variant="primary" onClick={handleContinue} disabled={saving}>
          {saving ? 'Saving…' : 'Continue'}
        </Button>
      </div>

      {orchestratorRoot === null && (
        <p
          className="mt-3 text-xs"
          style={{ color: 'var(--color-ink-muted)' }}
        >
          Note: NanoClaw root not detected — the wizard will use the bundled
          provider list.
        </p>
      )}
    </div>
  )
}

function ProviderCard({
  protocol,
  entry,
  active,
  onSelect
}: {
  protocol: string
  entry: ProviderRegistryEntry
  active: boolean
  onSelect: () => void
}) {
  const recommended = protocol === 'anthropic'
  return (
    <button
      type="button"
      onClick={onSelect}
      className="panel panel-hover flex flex-col items-stretch text-left px-5 py-4"
      style={{
        borderColor: active ? 'var(--color-ink)' : undefined,
        boxShadow: active ? 'var(--shadow-1)' : undefined,
        outline: active ? '2px solid var(--color-ink)' : 'none',
        outlineOffset: active ? '-2px' : 0
      }}
    >
      <div className="flex items-start justify-between gap-2 mb-1">
        <span
          className="text-sm font-medium"
          style={{ color: 'var(--color-ink)' }}
        >
          {entry.name}
        </span>
        {recommended && (
          <span
            className="text-[10px] tracking-wider uppercase font-semibold px-1.5 py-0.5 rounded"
            style={{
              color: 'var(--color-ink-on-accent)',
              background: 'var(--color-accent)'
            }}
          >
            Recommended
          </span>
        )}
        {!recommended && entry.capabilities.local && (
          <span
            className="text-[10px] tracking-wider uppercase font-semibold px-1.5 py-0.5 rounded"
            style={{
              color: 'var(--color-ink-muted)',
              background: 'var(--color-bg-subtle)'
            }}
          >
            Local
          </span>
        )}
      </div>
      <p
        className="text-xs mb-2"
        style={{ color: 'var(--color-ink-muted)', lineHeight: 1.5 }}
      >
        {entry.tagline}
      </p>
      <div
        className="flex flex-wrap gap-1.5 mb-2 text-[11px]"
        style={{ color: 'var(--color-ink-muted)' }}
      >
        {entry.capabilities.tool_use !== 'depends on model' && (
          <span>✓ {capabilityLabel('tools', entry.capabilities.tool_use)}</span>
        )}
        {entry.capabilities.vision && <span>✓ Vision</span>}
        {entry.capabilities.computer_use && <span>✓ Computer use</span>}
        {entry.capabilities.prompt_caching && <span>✓ Prompt caching</span>}
        {entry.capabilities.long_context && <span>✓ Long context</span>}
      </div>
      <p
        className="text-[11px] mt-auto pt-1"
        style={{ color: 'var(--color-ink-muted)' }}
      >
        {entry.cost_hint}
      </p>
    </button>
  )
}

function capabilityLabel(kind: 'tools', value: string): string {
  if (kind === 'tools') {
    if (value === 'best') return 'Best-in-class tools'
    if (value === 'strong') return 'Strong tools'
    return `${value[0].toUpperCase()}${value.slice(1)} tools`
  }
  return value
}

function capitalise(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s
}

function slugifyAgentId(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '') || 'agent'
  )
}

/**
 * Ensure the new agent's display name doesn't collide with an existing
 * agent's name. "Gemini" → "Gemini" if free; otherwise "Gemini 2",
 * "Gemini 3", etc.
 */
function ensureUniqueAgentName(
  base: string,
  existing: Array<{ name: string }>
): string {
  const names = new Set(existing.map((a) => a.name))
  if (!names.has(base)) return base
  for (let i = 2; i < 50; i++) {
    const candidate = `${base} ${i}`
    if (!names.has(candidate)) return candidate
  }
  return base + Date.now().toString().slice(-4)
}
