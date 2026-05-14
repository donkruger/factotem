import { useEffect, useRef, useState } from 'react'

interface Props {
  lines: string[]
  empty?: string
  maxHeight?: number
}

// Terminal-styled output panel. Used by long-running steps (container
// build, WhatsApp pair) to surface subprocess output without hijacking
// the user's actual terminal.
//
// Auto-scrolls to the bottom on new lines; copy button writes the
// full current buffer to the clipboard. Apple-flat — no glowing CRT
// effects, just a flat monospace block.
export function LogViewer({ lines, empty = 'Waiting for output…', maxHeight = 260 }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [lines])

  async function copyAll() {
    if (lines.length === 0) return
    try {
      await navigator.clipboard.writeText(lines.join('\n'))
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard write can fail in some sandbox contexts — silently skip
    }
  }

  return (
    <div
      className="panel-elevated overflow-hidden"
      style={{
        borderRadius: 'var(--radius-md)',
        border: '1px solid var(--color-hairline)'
      }}
    >
      <div
        className="flex items-center gap-1.5 px-3 py-2"
        style={{
          borderBottom: '1px solid var(--color-hairline)',
          background: 'var(--color-bg)'
        }}
      >
        <span className="w-2 h-2 rounded-full" style={{ background: '#fc625d' }} />
        <span className="w-2 h-2 rounded-full" style={{ background: '#fdbc40' }} />
        <span className="w-2 h-2 rounded-full" style={{ background: '#35cd4b' }} />
        <span
          className="text-[10px] ml-2 uppercase"
          style={{ color: 'var(--color-ink-muted)', letterSpacing: 'var(--tracking-caption)' }}
        >
          output
        </span>
        <button
          type="button"
          onClick={copyAll}
          disabled={lines.length === 0}
          className="ml-auto text-xs px-2.5 py-1 rounded-md transition-colors disabled:opacity-40"
          style={{
            color: copied ? 'var(--color-success)' : 'var(--color-ink-muted)',
            background: copied ? 'var(--color-success-bg)' : 'transparent'
          }}
          title="Copy the full log to your clipboard"
        >
          {copied ? 'Copied' : 'Copy output'}
        </button>
      </div>
      <div
        ref={scrollRef}
        className="overflow-y-auto font-mono text-xs px-3 py-2.5 whitespace-pre-wrap"
        style={{
          maxHeight,
          color: 'var(--color-ink)',
          background: 'var(--color-bg-elevated)',
          lineHeight: 1.55
        }}
      >
        {lines.length === 0 ? (
          <span style={{ color: 'var(--color-ink-dim)' }}>{empty}</span>
        ) : (
          lines.map((line, i) => <div key={i}>{line || ' '}</div>)
        )}
      </div>
    </div>
  )
}
