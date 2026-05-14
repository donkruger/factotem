import type { ProbeResult } from '@shared/types'

const STATUS_COLOR: Record<ProbeResult['status'], string> = {
  ok: 'var(--color-success)',
  warn: 'var(--color-warning)',
  error: 'var(--color-error)',
  checking: 'var(--color-ink-muted)'
}

const STATUS_BG: Record<ProbeResult['status'], string> = {
  ok: 'var(--color-success-bg)',
  warn: 'var(--color-warning-bg)',
  error: 'var(--color-error-bg)',
  checking: 'var(--color-bg-elevated)'
}

const STATUS_LABEL: Record<ProbeResult['status'], string> = {
  ok: 'OK',
  warn: 'Attention',
  error: 'Missing',
  checking: 'Checking…'
}

interface Props {
  probe: ProbeResult
  onOpenInstall?: () => void
}

// Flat-panel diagnostic row — mirrors the dashboard's Card +
// Badge pattern. Hairline border, subtle hover lift via .panel.
export function DiagnosticCard({ probe, onOpenInstall }: Props) {
  const color = STATUS_COLOR[probe.status]
  const bg = STATUS_BG[probe.status]

  return (
    <div className="panel panel-hover flex items-center justify-between gap-4 px-5 py-4">
      <div className="flex items-center gap-3 min-w-0">
        <div
          className={`w-2 h-2 rounded-full flex-shrink-0 ${
            probe.status === 'checking' ? 'animate-pulse' : ''
          }`}
          style={{ background: color }}
        />
        <div className="min-w-0">
          <div
            className="text-sm font-medium truncate"
            style={{ color: 'var(--color-ink)' }}
          >
            {probe.name}
          </div>
          <div
            className="text-xs truncate mt-0.5"
            style={{
              color: 'var(--color-ink-muted)',
              letterSpacing: 'var(--tracking-caption)'
            }}
            title={probe.detail}
          >
            {probe.detail}
          </div>
        </div>
      </div>

      <div className="flex items-center gap-3 flex-shrink-0">
        <span
          className="text-[10px] tracking-wider uppercase font-semibold px-2 py-1 rounded-md"
          style={{
            color,
            background: bg,
            letterSpacing: 'var(--tracking-caption)'
          }}
        >
          {STATUS_LABEL[probe.status]}
        </span>
        {!probe.ok && onOpenInstall && (
          <button
            type="button"
            onClick={onOpenInstall}
            className="text-xs hover:underline transition-opacity"
            style={{ color: 'var(--color-accent)' }}
          >
            Install
          </button>
        )}
      </div>
    </div>
  )
}
