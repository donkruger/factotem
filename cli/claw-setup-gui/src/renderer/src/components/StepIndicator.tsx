import type { StepId } from '../hooks/useWizard'

interface Props {
  steps: StepId[]
  labels: Record<StepId, string>
  current: StepId
}

// Compact step indicator — works for arbitrary step counts.
//
// Shows the current step's label + position ("Step 4 of 12 — Install"),
// surrounded by the previous and next labels in muted ink, with an
// orange progress bar at the bottom. Replaces the dotted-rail version
// that overflowed once the journey grew past ~6 steps.
export function StepIndicator({ steps, labels, current }: Props) {
  const idx = steps.indexOf(current)
  const total = steps.length
  const prev = idx > 0 ? labels[steps[idx - 1]] : null
  const next = idx < total - 1 ? labels[steps[idx + 1]] : null
  const progress = idx >= 0 ? ((idx + 1) / total) * 100 : 0

  return (
    <div
      className="relative z-10"
      style={{
        background: 'var(--color-bg)',
        borderBottom: '1px solid var(--color-hairline)'
      }}
    >
      <div className="flex items-center justify-between px-6 py-3.5">
        <div className="flex items-center gap-2 min-w-0">
          <span
            className="text-[10px] tracking-wider uppercase font-semibold flex-shrink-0"
            style={{
              color: 'var(--color-accent)',
              letterSpacing: 'var(--tracking-caption)'
            }}
          >
            Step {idx + 1} of {total}
          </span>
          <span
            className="text-[10px] tracking-wider uppercase truncate"
            style={{
              color: 'var(--color-ink)',
              letterSpacing: 'var(--tracking-caption)'
            }}
          >
            · {labels[current]}
          </span>
        </div>

        <div
          className="hidden sm:flex items-center gap-3 text-[10px] tracking-wider uppercase"
          style={{
            color: 'var(--color-ink-dim)',
            letterSpacing: 'var(--tracking-caption)'
          }}
        >
          {prev && <span>← {prev}</span>}
          {next && <span>{next} →</span>}
        </div>
      </div>

      {/* Progress rail */}
      <div
        className="h-[2px] w-full"
        style={{ background: 'var(--color-hairline)' }}
      >
        <div
          className="h-full transition-all duration-300"
          style={{
            width: `${progress}%`,
            background: 'var(--color-accent)'
          }}
        />
      </div>
    </div>
  )
}
