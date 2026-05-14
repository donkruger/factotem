import { useEffect, useState } from 'react'
import { Button } from '../components/Button'
import { useElectronAPI } from '../hooks/useElectronAPI'

interface Props {
  onNext: () => void
  onBack: () => void
}

interface Group {
  jid: string
  name: string
}

type Phase = 'orchestrator-down' | 'loading' | 'pick' | 'saving' | 'saved' | 'error'

// Step 07 — Register main WhatsApp group.
//
// Fully embedded: lists groups via `setup --step groups -- --list`,
// lets the user pick + customise trigger/folder/is-main in React, then
// runs `setup --step register -- --jid ...` to commit + SIGHUPs the
// orchestrator. No terminal handoff, no SQLite native module — both
// setup subcommands print/accept everything via stdout/CLI flags.
export function RegisterGroupStep({ onNext, onBack }: Props) {
  const api = useElectronAPI()
  const [orchestratorRoot, setOrchestratorRoot] = useState<string | null>(null)
  const [assistantName, setAssistantName] = useState('Andy')

  const [phase, setPhase] = useState<Phase>('loading')
  const [groups, setGroups] = useState<Group[]>([])
  const [error, setError] = useState<string | null>(null)

  const [selectedJid, setSelectedJid] = useState<string | null>(null)
  const [trigger, setTrigger] = useState('')
  const [folder, setFolder] = useState('')
  const [isMain, setIsMain] = useState(true)
  const [sighupSent, setSighupSent] = useState(false)

  useEffect(() => {
    if (!api) return
    void (async () => {
      const env = await api.env.check()
      setOrchestratorRoot(env.orchestratorRoot)
      const state = await api.state.read()
      const name = state?.assistantName ?? 'Andy'
      setAssistantName(name)
      setTrigger(`@${name}`)
      await refresh(env.orchestratorRoot)
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api])

  async function refresh(rootOverride?: string | null) {
    if (!api) return
    const root = rootOverride ?? orchestratorRoot
    if (!root) {
      setPhase('error')
      setError('NanoClaw checkout not detected — set it up first.')
      return
    }

    setPhase('loading')
    setError(null)

    // First check the orchestrator is alive — otherwise --list returns
    // an empty list or errors, and neither is a great UX without context.
    //
    // We use the lower bar (just `reachable: true`) here: if /health
    // responds at all, the orchestrator process exists and we can both
    // query its DB and SIGHUP it. The stricter `isFullyHealthy` check
    // is only for the boot-time "skip the whole wizard" decision.
    const health = await api.health.probe()
    if (!health.reachable) {
      setPhase('orchestrator-down')
      return
    }

    const r = await api.register.listGroups(root)
    if (r.error) {
      setPhase('error')
      setError(r.error)
      return
    }
    setGroups(r.groups)
    setPhase('pick')
  }

  async function save() {
    if (!api || !orchestratorRoot) return
    const group = groups.find((g) => g.jid === selectedJid)
    if (!group) return

    if (!/^@[A-Za-z][A-Za-z0-9]{1,19}$/.test(trigger)) {
      setError("Trigger must be `@Name` — alphanumeric, 2–20 chars, starting with a letter.")
      return
    }
    if (!/^[a-z0-9-]{2,32}$/.test(folder)) {
      setError('Folder must be 2–32 chars, lowercase letters / digits / dashes only.')
      return
    }

    setPhase('saving')
    setError(null)
    const r = await api.register.save(orchestratorRoot, {
      jid: group.jid,
      name: group.name,
      trigger,
      folder,
      isMain,
      assistantName
    })
    if (!r.success) {
      setPhase('pick')
      setError(r.error ?? 'Registration failed')
      return
    }
    setSighupSent(r.sighup)
    await api.state.patch({
      data: {
        main_group_registered_at: new Date().toISOString(),
        main_jid: group.jid,
        main_name: group.name
      }
    })
    setPhase('saved')
  }

  // Slugify the group name into a folder default when the user picks
  // a group, but don't clobber a hand-edited value.
  function pickGroup(g: Group) {
    setSelectedJid(g.jid)
    setError(null)
    const slug = g.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32) || 'whatsapp-main'
    setFolder(slug)
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
          Register the main WhatsApp group
        </h2>
        <p
          className="text-sm"
          style={{ color: 'var(--color-ink-muted)', lineHeight: 1.55 }}
        >
          The main group is where the agent answers <code>@</code>-mentions by
          default. Pick one of the groups the orchestrator has seen since it
          started.
        </p>
      </div>

      {phase === 'orchestrator-down' && (
        <div
          className="panel px-4 py-3 mb-5"
          style={{ borderRadius: 'var(--radius-md)' }}
        >
          <div className="flex items-start gap-3">
            <span
              className="w-2 h-2 rounded-full mt-2 flex-shrink-0"
              style={{ background: 'var(--color-warning)' }}
            />
            <div className="flex-1">
              <div className="text-sm font-medium" style={{ color: 'var(--color-ink)' }}>
                Orchestrator isn&apos;t responding yet
              </div>
              <div className="text-xs mt-1" style={{ color: 'var(--color-ink-muted)' }}>
                Step 09 installs the service. If you skipped it, go back and
                install — the registration query needs the orchestrator running.
              </div>
              <div className="flex items-center gap-3 mt-3">
                <Button variant="ghost" size="sm" onClick={() => refresh()}>
                  Retry
                </Button>
                <Button variant="ghost" size="sm" onClick={onBack}>
                  Back to service step
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {phase === 'loading' && (
        <div className="text-sm text-center py-8" style={{ color: 'var(--color-ink-muted)' }}>
          Querying orchestrator for recent WhatsApp groups…
        </div>
      )}

      {phase === 'error' && error && (
        <div
          className="text-sm mb-4 px-3 py-2 rounded-md"
          style={{ color: 'var(--color-error)', background: 'var(--color-error-bg)' }}
        >
          {error}
        </div>
      )}

      {(phase === 'pick' || phase === 'saving') && (
        <>
          {/* Group list */}
          {groups.length === 0 ? (
            <div
              className="panel px-4 py-3 mb-5 text-sm"
              style={{ color: 'var(--color-ink-muted)', borderRadius: 'var(--radius-md)' }}
            >
              No groups visible yet. Send a message to your intended main
              group from any other phone, then click <strong>Refresh</strong>{' '}
              below. Groups only appear after the orchestrator observes at
              least one message.
            </div>
          ) : (
            <div className="flex flex-col gap-1.5 mb-5">
              <div
                className="text-[10px] tracking-wider uppercase font-semibold"
                style={{
                  color: 'var(--color-ink-muted)',
                  letterSpacing: 'var(--tracking-caption)'
                }}
              >
                Recent groups ({groups.length})
              </div>
              {groups.map((g) => {
                const active = selectedJid === g.jid
                return (
                  <label
                    key={g.jid}
                    className="panel panel-hover flex items-center gap-3 px-4 py-3 cursor-pointer"
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
                      name="group"
                      value={g.jid}
                      checked={active}
                      onChange={() => pickGroup(g)}
                      className="accent-[color:var(--color-ink)]"
                    />
                    <div className="flex-1 min-w-0">
                      <div
                        className="text-sm font-medium truncate"
                        style={{ color: 'var(--color-ink)' }}
                        title={g.name}
                      >
                        {g.name}
                      </div>
                      <code
                        className="text-xs truncate block"
                        style={{ color: 'var(--color-ink-muted)' }}
                        title={g.jid}
                      >
                        {g.jid}
                      </code>
                    </div>
                  </label>
                )
              })}
            </div>
          )}

          {/* Settings — only shown after a group is picked */}
          {selectedJid && (
            <div className="flex flex-col gap-4 mb-5">
              <div>
                <label
                  className="block text-sm font-medium mb-1.5"
                  style={{ color: 'var(--color-ink)' }}
                >
                  Trigger
                </label>
                <input
                  type="text"
                  value={trigger}
                  onChange={(e) => setTrigger(e.target.value)}
                  placeholder="@Andy"
                  className="input-field font-mono"
                />
                <div className="text-xs mt-1.5" style={{ color: 'var(--color-ink-muted)' }}>
                  The string the agent watches for in messages. Default
                  matches your assistant name from step 00 ({assistantName}).
                </div>
              </div>

              <div>
                <label
                  className="block text-sm font-medium mb-1.5"
                  style={{ color: 'var(--color-ink)' }}
                >
                  Folder
                </label>
                <input
                  type="text"
                  value={folder}
                  onChange={(e) => setFolder(e.target.value.toLowerCase())}
                  placeholder="whatsapp-main"
                  className="input-field font-mono"
                />
                <div className="text-xs mt-1.5" style={{ color: 'var(--color-ink-muted)' }}>
                  Filesystem-safe name for this group&apos;s session and
                  memory directory under <code>groups/</code>. Lowercase, no
                  spaces.
                </div>
              </div>

              <label
                className="panel flex items-start gap-3 px-4 py-3 cursor-pointer"
                style={{ borderRadius: 'var(--radius-md)' }}
              >
                <input
                  type="checkbox"
                  checked={isMain}
                  onChange={(e) => setIsMain(e.target.checked)}
                  className="mt-0.5 accent-[color:var(--color-ink)]"
                />
                <div className="flex-1">
                  <div className="text-sm font-medium" style={{ color: 'var(--color-ink)' }}>
                    Mark as the main group
                  </div>
                  <div className="text-xs mt-0.5" style={{ color: 'var(--color-ink-muted)' }}>
                    Recommended for the first group registered. Main groups
                    get read/write access to allowed folders even when
                    non-main read-only is enabled.
                  </div>
                </div>
              </label>
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
        </>
      )}

      {phase === 'saved' && (
        <div
          className="panel px-4 py-3 mb-5"
          style={{ borderRadius: 'var(--radius-md)' }}
        >
          <div className="flex items-start gap-3">
            <span
              className="w-2 h-2 rounded-full mt-2 flex-shrink-0"
              style={{ background: 'var(--color-success)' }}
            />
            <div className="flex-1">
              <div className="text-sm font-medium" style={{ color: 'var(--color-ink)' }}>
                Registered
              </div>
              <div className="text-xs mt-1" style={{ color: 'var(--color-ink-muted)' }}>
                The orchestrator is{' '}
                {sighupSent ? (
                  <>now serving this group ({<code>SIGHUP</code>} sent — hot-reloaded).</>
                ) : (
                  <>configured. Restart the service to pick up the change.</>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="flex items-center justify-between gap-3 mt-auto pt-6">
        <Button variant="ghost" onClick={onBack} disabled={phase === 'saving'}>
          Back
        </Button>
        <div className="flex items-center gap-3">
          {(phase === 'pick' || phase === 'error') && (
            <Button variant="ghost" onClick={() => refresh()}>
              Refresh
            </Button>
          )}
          {phase === 'saved' ? (
            <Button onClick={onNext}>Continue</Button>
          ) : (
            <Button
              onClick={save}
              loading={phase === 'saving'}
              disabled={
                phase !== 'pick' || !selectedJid || !trigger || !folder
              }
            >
              Register
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
