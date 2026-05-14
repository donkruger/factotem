import { useEffect, useState, type FormEvent } from 'react'
import { Button } from '../components/Button'
import { useElectronAPI } from '../hooks/useElectronAPI'
import type { Profile, SetupState } from '@shared/types'

interface Props {
  onNext: () => void
  onBack: () => void
}

const PROFILES: Array<{
  id: Profile
  title: string
  hint: string
  badge?: string
}> = [
  {
    id: 'solo',
    title: 'Just me on my own machine',
    hint: 'Single operator, real WhatsApp, the standard layout.',
    badge: 'Recommended'
  },
  {
    id: 'hobbyist',
    title: 'Local experiment (no real WhatsApp)',
    hint: 'Try the framework offline before committing your phone.'
  },
  {
    id: 'collaborator-invite',
    title: "Joining someone else's deployment",
    hint: "You'll be redirected to the existing deployment's onboarding URL."
  }
]

const ASSISTANT_NAME_RE = /^[A-Za-z][A-Za-z0-9]{1,19}$/

// Equivalent of claw-setup step 00-profile-mode. The interactive prompts
// (which the CLI does via @clack/prompts inside `execute()`) are lifted
// into this React form. On submit the values are POSTed to the main
// process via `profile:write`, which persists them to setup-state.json
// and appends ASSISTANT_NAME to the orchestrator's .env.
export function ProfileStep({ onNext, onBack }: Props) {
  const api = useElectronAPI()
  const [profile, setProfile] = useState<Profile>('solo')
  const [assistantName, setAssistantName] = useState('Andy')
  const [orchestratorRoot, setOrchestratorRoot] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [statePath, setStatePath] = useState<string>('')

  useEffect(() => {
    if (!api) return
    void (async () => {
      const existing: SetupState | null = await api.state.read()
      if (existing) {
        setProfile(existing.profile)
        setAssistantName(existing.assistantName)
      }
      setStatePath(await api.state.statePath())
      const env = await api.env.check()
      setOrchestratorRoot(env.orchestratorRoot)
    })()
  }, [api])

  const nameValid = ASSISTANT_NAME_RE.test(assistantName.trim())
  const canSubmit = nameValid && !saving && !!api

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (!canSubmit || !api) return

    if (profile === 'collaborator-invite') {
      setError(
        'This wizard is for new deployments. To join an existing NanoClaw, ask the operator for their dashboard URL and visit /onboarding/accept-invite.'
      )
      return
    }

    setSaving(true)
    setError(null)
    try {
      const result = await api.profile.write({
        profile,
        assistantName: assistantName.trim(),
        orchestratorRoot
      })
      if (!result.success) {
        setError(result.error ?? 'Failed to save profile.')
        return
      }
      onNext()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="step-enter flex-1 flex flex-col px-10 py-7 relative z-10 max-w-2xl mx-auto w-full"
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
          Pick a profile and name your assistant
        </h2>
        <p
          className="text-sm"
          style={{ color: 'var(--color-ink-muted)', lineHeight: 1.55 }}
        >
          We&apos;ll save these to <code>{statePath || '~/.config/nanoclaw/setup-state.json'}</code>{' '}
          so you can step out and resume from the CLI or this wizard.
        </p>
      </div>

      <div className="flex flex-col gap-2.5 mb-6">
        {PROFILES.map((p) => {
          const active = profile === p.id
          return (
            <label
              key={p.id}
              className="panel panel-hover flex items-start gap-3 px-5 py-4 cursor-pointer"
              style={
                active
                  ? {
                      borderColor: 'var(--color-ink)',
                      boxShadow: 'var(--shadow-1)'
                    }
                  : {}
              }
            >
              <input
                type="radio"
                name="profile"
                value={p.id}
                checked={active}
                onChange={() => setProfile(p.id)}
                className="mt-1 accent-[color:var(--color-ink)]"
              />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span
                    className="text-sm font-medium"
                    style={{ color: 'var(--color-ink)' }}
                  >
                    {p.title}
                  </span>
                  {p.badge && (
                    <span
                      className="text-[10px] tracking-wider uppercase font-semibold px-1.5 py-0.5 rounded"
                      style={{
                        color: 'var(--color-accent)',
                        background: 'var(--color-accent-soft)',
                        letterSpacing: 'var(--tracking-caption)'
                      }}
                    >
                      {p.badge}
                    </span>
                  )}
                </div>
                <div
                  className="text-xs mt-0.5"
                  style={{ color: 'var(--color-ink-muted)' }}
                >
                  {p.hint}
                </div>
              </div>
            </label>
          )
        })}
      </div>

      <div className="mb-6">
        <label
          htmlFor="assistantName"
          className="block text-sm font-medium mb-1.5"
          style={{ color: 'var(--color-ink)' }}
        >
          What name should your assistant respond to?
        </label>
        <input
          id="assistantName"
          type="text"
          value={assistantName}
          onChange={(e) => setAssistantName(e.target.value)}
          placeholder="Andy"
          className="input-field"
          maxLength={20}
          autoComplete="off"
        />
        <div
          className="text-xs mt-1.5"
          style={{ color: 'var(--color-ink-muted)' }}
        >
          {nameValid ? (
            <>
              Trigger word: <code>@{assistantName.trim()}</code> · Signature:{' '}
              <code>{assistantName.trim()} here…</code>
            </>
          ) : (
            <span style={{ color: 'var(--color-warning)' }}>
              2–20 chars, alphanumeric, starting with a letter.
            </span>
          )}
        </div>
        {orchestratorRoot ? (
          <div
            className="text-xs mt-1.5"
            style={{ color: 'var(--color-ink-dim)' }}
          >
            Will append <code>ASSISTANT_NAME={assistantName.trim() || 'Andy'}</code> to{' '}
            <code>{orchestratorRoot}/.env</code> (idempotent).
          </div>
        ) : (
          <div
            className="text-xs mt-1.5"
            style={{ color: 'var(--color-warning)' }}
          >
            Orchestrator root not detected — .env write will be skipped. Profile + name still
            save to setup-state.json.
          </div>
        )}
      </div>

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
        <Button type="button" variant="ghost" onClick={onBack} disabled={saving}>
          Back
        </Button>
        <Button type="submit" disabled={!canSubmit} loading={saving}>
          Save and continue
        </Button>
      </div>
    </form>
  )
}
