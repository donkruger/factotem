import {
  HTMLAttributes,
  TableHTMLAttributes,
  TdHTMLAttributes,
  ThHTMLAttributes,
} from 'react';

export function Table({
  className = '',
  ...props
}: TableHTMLAttributes<HTMLTableElement>) {
  return (
    <div className="w-full overflow-x-auto rounded-lg border border-[var(--color-hairline)]">
      <table
        className={`w-full border-collapse text-sm ${className}`}
        {...props}
      />
    </div>
  );
}

export function TableHead({
  className = '',
  ...props
}: HTMLAttributes<HTMLTableSectionElement>) {
  return (
    <thead
      className={`bg-[var(--color-bg-subtle)] text-left text-xs uppercase tracking-wide text-[var(--color-ink-muted)] ${className}`}
      {...props}
    />
  );
}

export function TableBody({
  className = '',
  ...props
}: HTMLAttributes<HTMLTableSectionElement>) {
  return <tbody className={className} {...props} />;
}

export function TableRow({
  className = '',
  ...props
}: HTMLAttributes<HTMLTableRowElement>) {
  return (
    <tr
      className={`border-t border-[var(--color-hairline)] transition-colors duration-150 hover:bg-[var(--color-bg-subtle)] ${className}`}
      {...props}
    />
  );
}

interface TableCellProps extends TdHTMLAttributes<HTMLTableCellElement> {
  /** Render as <th> when in a header row. */
  header?: boolean;
  thProps?: ThHTMLAttributes<HTMLTableCellElement>;
}

export function TableCell({
  header = false,
  className = '',
  thProps,
  ...props
}: TableCellProps) {
  const base = 'px-4 py-3 align-middle';
  if (header) {
    return (
      <th
        className={`${base} font-medium text-[var(--color-ink)] ${className}`}
        {...thProps}
        {...(props as ThHTMLAttributes<HTMLTableCellElement>)}
      />
    );
  }
  return (
    <td
      className={`${base} text-[var(--color-ink)] ${className}`}
      {...props}
    />
  );
}
