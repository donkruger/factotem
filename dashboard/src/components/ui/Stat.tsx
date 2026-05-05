import { HTMLAttributes } from 'react';

interface StatProps extends HTMLAttributes<HTMLDivElement> {
  label: string;
  value: string;
  sublabel?: string;
}

export function Stat({
  label,
  value,
  sublabel,
  className = '',
  ...props
}: StatProps) {
  return (
    <div className={`flex flex-col gap-1 ${className}`} {...props}>
      <span className="text-xs text-[var(--color-ink-muted)]">{label}</span>
      <span className="text-2xl font-medium text-[var(--color-ink)]">
        {value}
      </span>
      {sublabel && (
        <span className="text-xs text-[var(--color-ink-muted)]">
          {sublabel}
        </span>
      )}
    </div>
  );
}
