import { useState } from 'react'
import { useElectronAPI } from '../hooks/useElectronAPI'

interface Props {
  command: string
  caption?: string
  showCopy?: boolean
  showOpenTerminal?: boolean
}

// Styled command block — used by steps that hand off to the CLI.
// Renders the command in a code block with the brand accent colour
// and offers Copy and "Open in Terminal" affordances. Matches the
// dashboard's monospace treatment.
export function CommandBlock({
  command,
  caption,
  showCopy = true,
  showOpenTerminal = true
}: Props) {
  const api = useElectronAPI()
  const [copied, setCopied] = useState(false)
  const [opening, setOpening] = useState(false)

  async function copy() {
    try {
      await navigator.clipboard.writeText(command)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard write can fail in sandboxed contexts; silently skip
    }
  }

  async function openInTerminal() {
    if (!api) return
    setOpening(true)
    try {
      await api.terminal.run(command)
    } finally {
      setOpening(false)
    }
  }

  return (
    <div className="my-3">
      {caption && (
        <div
          className="text-[10px] tracking-wider uppercase font-semibold mb-1.5"
          style={{
            color: 'var(--color-ink-muted)',
            letterSpacing: 'var(--tracking-caption)'
          }}
        >
          {caption}
        </div>
      )}
      <div
        className="panel-elevated px-4 py-3 font-mono text-sm flex items-center justify-between gap-3"
        style={{ borderRadius: 'var(--radius-md)' }}
      >
        <code
          className="overflow-x-auto whitespace-nowrap flex-1 min-w-0"
          style={{ color: 'var(--color-accent)' }}
        >
          {command}
        </code>
        <div className="flex items-center gap-1 flex-shrink-0">
          {showCopy && (
            <button
              type="button"
              onClick={copy}
              className="text-xs px-2.5 py-1 rounded-md transition-colors"
              style={{
                color: copied ? 'var(--color-success)' : 'var(--color-ink-muted)',
                background: copied ? 'var(--color-success-bg)' : 'transparent'
              }}
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
          )}
          {showOpenTerminal && (
            <button
              type="button"
              onClick={openInTerminal}
              disabled={opening || !api}
              className="text-xs px-2.5 py-1 rounded-md transition-colors hover:bg-[color:var(--color-bg)]"
              style={{ color: 'var(--color-ink-muted)' }}
            >
              {opening ? 'Opening…' : 'Open in Terminal'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
