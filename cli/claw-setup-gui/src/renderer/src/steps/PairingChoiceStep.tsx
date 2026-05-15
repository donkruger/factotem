import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { Button } from '../components/Button'
import { useElectronAPI } from '../hooks/useElectronAPI'
import type { StepId } from '../hooks/useWizard'

interface Props {
  /**
   * Linear-next is intentionally absent from this step's contract.
   * PairingChoice always routes via `onJump`: shared → 'mounts', new
   * → 'whatsapp', no-flag → 'mounts'. Keeping the signature explicit
   * about this prevents a future contributor from wiring it into a
   * straight-line wizard sequence where it doesn't belong.
   */
  onJump: (id: StepId) => void
  onBack: () => void
}

type Choice = 'shared' | 'new'

interface PairingSummary {
  id: string
  kind: string
  display_name: string
  is_shared: boolean
  phone_hint: string | null
}

/**
 * PairingChoiceStep — only renders when state.data.__mode === 'add-agent'.
 *
 * Asks the operator whether the new agent uses the deployment's
 * shared WhatsApp pairing or pairs its own number (v1.2.1-finish-
 * blueprint § 2).
 *
 * Apple-philosophy heuristics applied:
 *   - One primary action per screen — Continue is primary.
 *   - Names beat IDs — show the shared pairing's display_name, not
 *     its slug.
 *   - Reversible by default — the choice writes to setup-state but
 *     doesn't fire the QR scan until the operator commits. Back goes
 *     back to CredentialsStep with no orchestrator side-effects.
 *   - Empty state teaches — a single explanatory paragraph at the
 *     top sets context for the non-technical operator.
 */
export function PairingChoiceStep({ onJump, onBack }: Props) {
  const api = useElectronAPI()
  const [choice, setChoice] = useState<Choice>('shared')
  const [pairings, setPairings] = useState<PairingSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [pendingAgentId, setPendingAgentId] = useState<string | null>(null)
  const [pendingAgentName, setPendingAgentName] = useState<string | null>(null)
  const [displayName, setDisplayName] = useState('')
  const [phoneHint, setPhoneHint] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  useEffect(() => {
    if (!api) return
    void (async () => {
      try {
        const existing = await api.state.read()
        // First gate: are we in add-agent mode at all? PairingChoice
        // is only meaningful when there's a freshly-created agent to
        // attach a pairing to. First-run installs see no flags here,
        // and we fall through to the next step (Mounts) silently.
        const agentId =
          (existing?.data['__pending_credential_agent_id'] as
            | string
            | undefined) ?? null
        if (!agentId) {
          // No add-agent hand-off — auto-advance to Mounts (the step
          // that linearly follows Credentials in STEPS) so a stale
          // back-navigation to this branch doesn't dead-end. The
          // operator never sees this screen in the first-run path
          // because Credentials only routes here when the flag is set.
          onJump('mounts')
          return
        }
        setPendingAgentId(agentId)
        const agent = existing?.agents.find((a) => a.id === agentId)
        if (agent) {
          setPendingAgentName(agent.name)
          setDisplayName(`${agent.name}'s WhatsApp`)
        }
        const result = await api.pairings.list()
        if (result.error) {
          // Soft-fail: orchestrator may be down. The operator can
          // still pair a new number; we just lose the "use shared"
          // affordance until it's reachable. The empty list flows
          // through to the radio below — "Use shared" disables itself
          // when there's no pairing to point at.
          setLoadError(result.error)
        }
        setPairings(result.pairings ?? [])
      } catch (err) {
        setLoadError((err as Error).message)
      } finally {
        setLoading(false)
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api])

  // Pick a sensible shared default — first WhatsApp pairing flagged
  // shared, or the first WhatsApp pairing overall as a fallback.
  const sharedPairing = useMemo(() => {
    return (
      pairings.find((p) => p.kind === 'whatsapp' && p.is_shared) ??
      pairings.find((p) => p.kind === 'whatsapp') ??
      null
    )
  }, [pairings])

  // Validation: "new" path needs at least a display name.
  const newDisplayName = displayName.trim()
  const newPathReady = newDisplayName.length >= 2 && newDisplayName.length <= 60
  const sharedPathReady = !!sharedPairing
  const canContinue =
    !saving &&
    !!api &&
    !!pendingAgentId &&
    ((choice === 'shared' && sharedPathReady) ||
      (choice === 'new' && newPathReady))

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (!api || !pendingAgentId || !canContinue) return
    setSaveError(null)
    setSaving(true)
    try {
      if (choice === 'shared') {
        if (!sharedPairing) {
          setSaveError(
            "No shared WhatsApp pairing on this deployment yet. Pick 'Pair a new WhatsApp number' instead."
          )
          return
        }
        // Point the new agent at the existing shared pairing. The
        // orchestrator does the persistence + audit + reload.
        const r = await api.pairings.assignAgent(pendingAgentId, sharedPairing.id)
        if (!r.success) {
          setSaveError(r.error ?? 'Could not assign the shared pairing.')
          return
        }
        // Clear all add-agent hand-off flags now that the new agent
        // is fully wired to a pairing. WhatsAppStep won't fire because
        // we route the operator to `mounts` directly.
        await api.state.patch({
          data: {
            __pending_pairing_id: undefined,
            __pending_pairing_auth_dir: undefined,
            __pending_credential_agent_id: undefined,
            __mode: undefined
          }
        })
        // Shared-pairing path: skip WhatsAppStep entirely.
        onJump('mounts')
        return
      }

      // 'new' path — register a pairing, then point the new agent at
      // it, then jump to WhatsAppStep parameterised by the new
      // pairing.
      const created = await api.pairings.create({
        kind: 'whatsapp',
        display_name: newDisplayName,
        phone_hint: phoneHint.trim() ? phoneHint.trim() : null,
        is_shared: false
      })
      if (!created.success || !created.pairing) {
        setSaveError(created.error ?? 'Could not register the new pairing.')
        return
      }
      const newPairing = created.pairing

      const assigned = await api.pairings.assignAgent(
        pendingAgentId,
        newPairing.id
      )
      if (!assigned.success) {
        setSaveError(
          assigned.error ?? 'Pairing created but agent assignment failed.'
        )
        return
      }

      // Stash the per-pairing context for WhatsAppStep and clear the
      // add-agent hand-off flags — pairing is now the only mid-flight
      // piece of state for this run.
      await api.state.patch({
        data: {
          __pending_pairing_id: newPairing.id,
          __pending_pairing_auth_dir: newPairing.auth_path,
          __pending_credential_agent_id: undefined,
          __mode: undefined
        }
      })

      onJump('whatsapp')
    } catch (err) {
      setSaveError((err as Error).message)
    } finally {
      setSaving(false)
    }
  }


  if (loading) {
    return (
      <div className="step-enter flex-1 flex items-center justify-center p-10">
        <p style={{ color: 'var(--color-ink-muted)' }}>Loading pairings…</p>
      </div>
    )
  }

  // Guard against the add-agent flow being entered without a pending
  // agent id (e.g. somebody jumped here from a deep link). We can't
  // make a sensible choice without an agent to attach the pairing to,
  // so route the operator back to where the agent gets created.
  if (!pendingAgentId) {
    return (
      <div className="step-enter flex-1 flex flex-col px-10 py-7 max-w-2xl mx-auto w-full">
        <h2
          className="text-2xl mb-2"
          style={{ color: 'var(--color-ink)', fontWeight: 600 }}
        >
          Nothing to pair yet
        </h2>
        <p
          className="text-sm mb-6"
          style={{ color: 'var(--color-ink-muted)', lineHeight: 1.55 }}
        >
          This step assigns a WhatsApp pairing to a new agent. Pick a
          model and add credentials first.
        </p>
        <div className="flex gap-3 mt-auto pt-4">
          <Button variant="ghost" onClick={onBack}>
            Back
          </Button>
          <Button variant="primary" onClick={() => onJump('provider')}>
            Go to provider
          </Button>
        </div>
      </div>
    )
  }

  const agentLabel = pendingAgentName ?? 'this agent'

  return (
    <form
      onSubmit={handleSubmit}
      className="step-enter flex-1 flex flex-col px-10 py-7 max-w-2xl mx-auto w-full"
    >
      <div className="mb-6">
        <h2
          className="text-2xl mb-1"
          style={{
            color: 'var(--color-ink)',
            letterSpacing: 'var(--tracking-display)',
            fontWeight: 600
          }}
        >
          Which WhatsApp number should {agentLabel} use?
        </h2>
        <p
          className="text-sm"
          style={{ color: 'var(--color-ink-muted)', lineHeight: 1.55 }}
        >
          Pick whether {agentLabel} answers from this deployment&apos;s
          existing WhatsApp number or gets a dedicated one. You can
          change this later from the dashboard&apos;s Agents page.
        </p>
      </div>

      <div className="flex flex-col gap-2.5 mb-6">
        {/* Shared option */}
        <label
          className="panel panel-hover flex items-start gap-3 px-5 py-4 cursor-pointer"
          style={
            choice === 'shared'
              ? {
                  borderColor: 'var(--color-ink)',
                  boxShadow: 'var(--shadow-1)',
                  outline: '2px solid var(--color-ink)',
                  outlineOffset: '-2px'
                }
              : {}
          }
        >
          <input
            type="radio"
            name="pairing"
            value="shared"
            checked={choice === 'shared'}
            onChange={() => setChoice('shared')}
            disabled={!sharedPairing}
            className="mt-1 accent-[color:var(--color-ink)]"
          />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span
                className="text-sm font-medium"
                style={{ color: 'var(--color-ink)' }}
              >
                {sharedPairing
                  ? `Use ${sharedPairing.display_name}`
                  : 'Use the shared WhatsApp pairing'}
              </span>
              <span
                className="text-[10px] tracking-wider uppercase font-semibold px-1.5 py-0.5 rounded"
                style={{
                  color: 'var(--color-ink-on-accent)',
                  background: 'var(--color-accent)'
                }}
              >
                Recommended
              </span>
            </div>
            <div
              className="text-xs mt-0.5"
              style={{ color: 'var(--color-ink-muted)' }}
            >
              {sharedPairing ? (
                <>
                  Operators address {agentLabel} by{' '}
                  <code>@{agentLabel}</code> in any group the deployment
                  is in. One phone number, every agent.
                  {sharedPairing.phone_hint && (
                    <span style={{ color: 'var(--color-ink-dim)' }}>
                      {' '}
                      ({sharedPairing.phone_hint})
                    </span>
                  )}
                </>
              ) : (
                <>
                  No WhatsApp pairings on this deployment yet — start by
                  pairing a number below.
                </>
              )}
            </div>
          </div>
        </label>

        {/* New option */}
        <label
          className="panel panel-hover flex items-start gap-3 px-5 py-4 cursor-pointer"
          style={
            choice === 'new'
              ? {
                  borderColor: 'var(--color-ink)',
                  boxShadow: 'var(--shadow-1)',
                  outline: '2px solid var(--color-ink)',
                  outlineOffset: '-2px'
                }
              : {}
          }
        >
          <input
            type="radio"
            name="pairing"
            value="new"
            checked={choice === 'new'}
            onChange={() => setChoice('new')}
            className="mt-1 accent-[color:var(--color-ink)]"
          />
          <div className="flex-1 min-w-0">
            <div
              className="text-sm font-medium"
              style={{ color: 'var(--color-ink)' }}
            >
              Pair a new WhatsApp number for {agentLabel}
            </div>
            <div
              className="text-xs mt-0.5 mb-3"
              style={{ color: 'var(--color-ink-muted)' }}
            >
              {agentLabel} gets a dedicated phone number. Operators
              message that number directly — no <code>@</code>-prefix
              needed.
            </div>

            {choice === 'new' && (
              <div
                className="flex flex-col gap-3 pt-3"
                style={{ borderTop: '1px solid var(--color-hairline)' }}
              >
                <div>
                  <label
                    htmlFor="pairing-display-name"
                    className="block text-xs font-medium mb-1.5"
                    style={{ color: 'var(--color-ink)' }}
                  >
                    Display name
                  </label>
                  <input
                    id="pairing-display-name"
                    type="text"
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    placeholder={`${agentLabel}'s WhatsApp`}
                    maxLength={60}
                    className="input-field"
                    autoComplete="off"
                  />
                  <div
                    className="text-[11px] mt-1"
                    style={{ color: 'var(--color-ink-muted)' }}
                  >
                    How this pairing appears on the dashboard. 2–60
                    characters.
                  </div>
                </div>
                <div>
                  <label
                    htmlFor="pairing-phone-hint"
                    className="block text-xs font-medium mb-1.5"
                    style={{ color: 'var(--color-ink)' }}
                  >
                    Phone hint{' '}
                    <span style={{ color: 'var(--color-ink-dim)' }}>
                      (optional)
                    </span>
                  </label>
                  <input
                    id="pairing-phone-hint"
                    type="text"
                    value={phoneHint}
                    onChange={(e) => setPhoneHint(e.target.value)}
                    placeholder="+27 82 …"
                    maxLength={40}
                    className="input-field"
                    autoComplete="off"
                  />
                  <div
                    className="text-[11px] mt-1"
                    style={{ color: 'var(--color-ink-muted)' }}
                  >
                    A reminder of which phone this is on. Stored as
                    metadata only — never sent anywhere.
                  </div>
                </div>
              </div>
            )}
          </div>
        </label>
      </div>

      {loadError && (
        <div
          className="text-xs mb-4 px-3 py-2 rounded-md"
          style={{
            color: 'var(--color-warning)',
            background: 'var(--color-warning-bg)'
          }}
        >
          Couldn&apos;t load existing pairings ({loadError}). You can
          still pair a new number, but the &quot;use shared&quot; option
          is unavailable until the orchestrator is reachable.
        </div>
      )}

      {saveError && (
        <div
          className="text-sm mb-4 px-3 py-2 rounded-md"
          style={{
            color: 'var(--color-error)',
            background: 'var(--color-error-bg)'
          }}
        >
          {saveError}
        </div>
      )}

      <div className="flex gap-3 justify-end mt-auto pt-4">
        <Button
          type="button"
          variant="ghost"
          onClick={onBack}
          disabled={saving}
        >
          Back
        </Button>
        <Button type="submit" variant="primary" disabled={!canContinue}>
          {saving
            ? 'Saving…'
            : choice === 'shared'
              ? 'Use shared and continue'
              : 'Pair new number'}
        </Button>
      </div>
    </form>
  )
}
