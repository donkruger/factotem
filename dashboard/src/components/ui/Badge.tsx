import { HTMLAttributes } from 'react';

type Variant = 'success' | 'warning' | 'error' | 'neutral';

interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: Variant;
}

const variants: Record<Variant, string> = {
  success:
    'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300',
  warning:
    'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
  error:
    'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300',
  neutral:
    'border border-[var(--color-hairline)] bg-[var(--color-bg-subtle)] text-[var(--color-ink-muted)]',
};

export function Badge({
  variant = 'neutral',
  className = '',
  ...props
}: BadgeProps) {
  const base =
    'inline-flex items-center gap-1.5 rounded-pill px-2.5 py-0.5 text-xs font-medium';
  return (
    <span className={`${base} ${variants[variant]} ${className}`} {...props} />
  );
}
