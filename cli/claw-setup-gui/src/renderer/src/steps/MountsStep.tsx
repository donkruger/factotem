import { useEffect, useState } from 'react'
import { Button } from '../components/Button'
import { useElectronAPI } from '../hooks/useElectronAPI'
import type { AllowedRoot } from '@shared/types'

interface Props {
  onNext: () => void
  onBack: () => void
}

// Step 04 — Mounts allowlist.
//
// Each allowed root is an object: { path, allowReadWrite, description? }.
// Schema is mirrored from `nanoclaw/src/types.ts` — keep them in sync.
//
// UI per-entry:
//   • path (truncated, full on hover)
//   • description field (optional, free-text)
//   • R/W ↔ R-only toggle
//   • remove button
//
// Global toggle: nonMainReadOnly. Default true.
//
// `blockedPatterns` is preserved through read/write but not edited here —
// it's an advanced security knob and the empty default is fine for v0.1.
export function MountsStep({ onNext, onBack }: Props) {
  const api = useElectronAPI()
  const [roots, setRoots] = useState<AllowedRoot[]>([])
  const [blockedPatterns, setBlockedPatterns] = useState<string[]>([])
  const [readOnly, setReadOnly] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    if (!api) return
    void (async () => {
      const existing = await api.mounts.read()
      setRoots(existing.allowedRoots)
      setBlockedPatterns(existing.blockedPatterns)
      setReadOnly(existing.nonMainReadOnly)
      setLoaded(true)
    })()
  }, [api])

  async function addDirectory() {
    if (!api) return
    setError(null)
    const result = await api.mounts.pickDirectory()
    if (result.canceled || !result.path) return
    if (roots.some((r) => r.path === result.path)) {
      setError(`${result.path} is already in the allowlist.`)
      return
    }
    setRoots([
      ...roots,
      { path: result.path, allowReadWrite: true, description: '' }
    ])
  }

  function updateRoot(idx: number, patch: Partial<AllowedRoot>) {
    setRoots(roots.map((r, i) => (i === idx ? { ...r, ...patch } : r)))
  }

  function removeRoot(idx: number) {
    setRoots(roots.filter((_, i) => i !== idx))
  }

  async function save() {
    if (!api) return
    setSaving(true)
    setError(null)
    try {
      // Drop empty descriptions on the way out — matches the example
      // config in nanoclaw/config-examples/mount-allowlist.json where
      // entries either have a description or omit the field.
      const normalized: AllowedRoot[] = roots.map((r) => ({
        path: r.path,
        allowReadWrite: r.allowReadWrite,
        ...(r.description?.trim() ? { description: r.description.trim() } : {})
      }))
      await api.mounts.write({
        allowedRoots: normalized,
        blockedPatterns,
        nonMainReadOnly: readOnly
      })
      await api.state.patch({
        data: {
          mounts_allowlist_count: normalized.length,
          mounts_non_main_read_only: readOnly
        }
      })
      onNext()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="step-enter flex-1 flex flex-col px-10 py-7 relative z-10 max-w-2xl mx-auto w-full">
      <div className="mb-6">
        <h2
          className="text-2xl mb-1"
          style={{
            color: 'var(--color-ink)',
            letterSpacing: 'var(--tracking-display)',
            fontWeight: 600
          }}
        >
          Allow agent container access to folders
        </h2>
        <p
          className="text-sm"
          style={{ color: 'var(--color-ink-muted)', lineHeight: 1.55 }}
        >
          The agent container is jailed by default. List the host folders
          you want it to be able to read or write. You can start empty
          and add more later — the main group always gets read/write access
          to its own session directory.
        </p>
      </div>

      <div className="mb-5">
        <div
          className="text-[10px] tracking-wider uppercase font-semibold mb-2"
          style={{ color: 'var(--color-ink-muted)', letterSpacing: 'var(--tracking-caption)' }}
        >
          Allowed host folders
        </div>
        <div className="flex flex-col gap-2 mb-3">
          {roots.length === 0 ? (
            <div
              className="panel px-4 py-3 text-sm"
              style={{ color: 'var(--color-ink-muted)' }}
            >
              No folders allowed. The agent will only see its own session
              directory. Add at least <code>~/projects</code> or similar so
              it can read your work.
            </div>
          ) : (
            roots.map((r, idx) => (
              <div
                key={`${r.path}-${idx}`}
                className="panel px-4 py-3 flex flex-col gap-2"
              >
                <div className="flex items-center justify-between gap-3 min-w-0">
                  <code
                    className="text-sm flex-1 min-w-0 truncate"
                    style={{ color: 'var(--color-ink)' }}
                    title={r.path}
                  >
                    {r.path}
                  </code>
                  <button
                    type="button"
                    onClick={() => removeRoot(idx)}
                    className="text-xs hover:underline flex-shrink-0"
                    style={{ color: 'var(--color-ink-muted)' }}
                  >
                    Remove
                  </button>
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                  <button
                    type="button"
                    onClick={() => updateRoot(idx, { allowReadWrite: !r.allowReadWrite })}
                    className="text-[10px] tracking-wider uppercase font-semibold px-2 py-1 rounded transition-colors"
                    style={{
                      color: r.allowReadWrite
                        ? 'var(--color-success)'
                        : 'var(--color-ink-muted)',
                      background: r.allowReadWrite
                        ? 'var(--color-success-bg)'
                        : 'var(--color-bg-elevated)',
                      letterSpacing: 'var(--tracking-caption)'
                    }}
                    title="Click to toggle read-only / read-write"
                  >
                    {r.allowReadWrite ? 'Read · Write' : 'Read-only'}
                  </button>
                  <input
                    type="text"
                    value={r.description ?? ''}
                    onChange={(e) => updateRoot(idx, { description: e.target.value })}
                    placeholder="optional description"
                    className="flex-1 min-w-0 text-xs px-2.5 py-1 rounded-md outline-none"
                    style={{
                      background: 'var(--color-bg-elevated)',
                      color: 'var(--color-ink)',
                      border: '1px solid var(--color-hairline)'
                    }}
                  />
                </div>
              </div>
            ))
          )}
        </div>
        <Button variant="ghost" size="sm" onClick={addDirectory} disabled={!loaded}>
          + Add folder
        </Button>
      </div>

      <label
        className="panel flex items-start gap-3 px-4 py-3 cursor-pointer mb-5"
        style={{ borderRadius: 'var(--radius-md)' }}
      >
        <input
          type="checkbox"
          checked={readOnly}
          onChange={(e) => setReadOnly(e.target.checked)}
          className="mt-0.5 accent-[color:var(--color-ink)]"
        />
        <div className="flex-1">
          <div className="text-sm font-medium" style={{ color: 'var(--color-ink)' }}>
            Non-main groups are read-only by default
          </div>
          <div className="text-xs mt-0.5" style={{ color: 'var(--color-ink-muted)' }}>
            Recommended. Only the main WhatsApp group can write to allowed folders;
            other groups get read-only access regardless of per-folder settings.
          </div>
        </div>
      </label>

      {blockedPatterns.length > 0 && (
        <div
          className="text-xs mb-5 px-3 py-2 rounded-md"
          style={{
            color: 'var(--color-ink-muted)',
            background: 'var(--color-bg-elevated)',
            border: '1px solid var(--color-hairline)'
          }}
        >
          <strong style={{ color: 'var(--color-ink)' }}>Blocked patterns preserved:</strong>{' '}
          <code>{blockedPatterns.join(', ')}</code>. Edit{' '}
          <code>~/.config/nanoclaw/mount-allowlist.json</code> directly to
          change these — the GUI only edits the allowlist.
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
        <Button variant="ghost" onClick={onBack} disabled={saving}>
          Back
        </Button>
        <Button onClick={save} loading={saving} disabled={!loaded}>
          Save and continue
        </Button>
      </div>
    </div>
  )
}
