import React from 'react'

type Variant = 'primary' | 'ghost' | 'accent'
type Size = 'sm' | 'md' | 'lg'

interface Props extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  size?: Size
  loading?: boolean
}

// Mirrors dashboard/src/components/ui/Button.tsx.
//
// `primary`  — dark ink button on white. The dashboard's canonical CTA.
// `ghost`    — bordered, neutral. Use for "Back" / "Cancel" / secondary.
// `accent`   — warm orange. Reserve for the brand-moment CTA at the end
//              of the wizard ("Open dashboard"). Don't use elsewhere
//              unless you also see it in the dashboard.
const sizeClass: Record<Size, string> = {
  sm: 'px-4 py-1.5 text-sm',
  md: 'px-5 py-2.5 text-sm',
  lg: 'px-6 py-3 text-sm'
}

export function Button({
  variant = 'primary',
  size = 'md',
  loading,
  children,
  className = '',
  disabled,
  ...rest
}: Props) {
  const base =
    'inline-flex items-center justify-center gap-2 font-medium rounded-[var(--radius-pill)] ' +
    'transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed ' +
    'focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-[color:var(--color-focus-ring)]'

  const variantClass: Record<Variant, string> = {
    primary:
      'bg-[color:var(--color-ink)] text-[color:var(--color-bg)] ' +
      'hover:-translate-y-px hover:shadow-[var(--shadow-1)]',
    ghost:
      'border border-[color:var(--color-hairline)] text-[color:var(--color-ink)] ' +
      'hover:bg-[color:var(--color-bg-subtle)]',
    accent:
      'bg-[color:var(--color-accent)] text-white ' +
      'hover:bg-[color:var(--color-accent-hover)] hover:-translate-y-px hover:shadow-[var(--shadow-1)]'
  }

  return (
    <button
      {...rest}
      disabled={disabled || loading}
      className={`${base} ${sizeClass[size]} ${variantClass[variant]} ${className}`}
    >
      {loading && (
        <span
          aria-hidden
          className="inline-block w-3.5 h-3.5 border-2 border-current border-t-transparent rounded-full animate-spin"
        />
      )}
      {children}
    </button>
  )
}
