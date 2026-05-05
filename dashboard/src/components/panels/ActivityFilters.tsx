'use client';

import { Search, X } from 'lucide-react';

import type { Group } from '@/lib/nanoclaw';

export type Outcome = 'all' | 'success' | 'error' | 'budget_capped';
export type TimeRange = '1h' | '24h' | '7d' | 'all';

export interface FilterState {
  group: string; // group_folder; empty = all
  model: string; // empty = all
  outcome: Outcome;
  range: TimeRange;
  query: string;
}

interface Props {
  filters: FilterState;
  onChange: (next: Partial<FilterState>) => void;
  groups: Group[];
  models: string[];
  onClear: () => void;
}

const RANGES: { value: TimeRange; label: string }[] = [
  { value: '1h', label: '1h' },
  { value: '24h', label: '24h' },
  { value: '7d', label: '7d' },
  { value: 'all', label: 'All' },
];

const OUTCOMES: { value: Outcome; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'success', label: 'Success' },
  { value: 'error', label: 'Error' },
  { value: 'budget_capped', label: 'Budget capped' },
];

export function ActivityFilters({
  filters,
  onChange,
  groups,
  models,
  onClear,
}: Props) {
  const hasAnyFilter =
    filters.group !== '' ||
    filters.model !== '' ||
    filters.outcome !== 'all' ||
    filters.range !== '24h' ||
    filters.query !== '';

  return (
    <div className="space-y-3">
      <div className="relative">
        <Search
          className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--color-ink-muted)]"
          aria-hidden="true"
        />
        <input
          type="search"
          placeholder="Search messages by content…"
          value={filters.query}
          onChange={(e) => onChange({ query: e.target.value })}
          className="w-full rounded-xl border border-[var(--color-hairline)] bg-[var(--color-bg)] py-2.5 pl-10 pr-4 text-sm text-[var(--color-ink)] placeholder:text-[var(--color-ink-muted)] focus:border-[var(--color-ink)] focus:outline-none"
        />
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <label className="text-xs uppercase tracking-wider text-[var(--color-ink-muted)]">
            Group
          </label>
          <select
            value={filters.group}
            onChange={(e) => onChange({ group: e.target.value })}
            className="rounded-pill border border-[var(--color-hairline)] bg-[var(--color-bg)] px-3 py-1.5 text-sm text-[var(--color-ink)] focus:border-[var(--color-ink)] focus:outline-none"
          >
            <option value="">All groups</option>
            {groups.map((g) => (
              <option key={g.folder} value={g.folder}>
                {g.name || g.folder}
              </option>
            ))}
          </select>
        </div>

        <div className="flex items-center gap-2">
          <label className="text-xs uppercase tracking-wider text-[var(--color-ink-muted)]">
            Model
          </label>
          <select
            value={filters.model}
            onChange={(e) => onChange({ model: e.target.value })}
            className="rounded-pill border border-[var(--color-hairline)] bg-[var(--color-bg)] px-3 py-1.5 text-sm text-[var(--color-ink)] focus:border-[var(--color-ink)] focus:outline-none"
          >
            <option value="">All models</option>
            {models.map((m) => (
              <option key={m} value={m}>
                {shortenModel(m)}
              </option>
            ))}
          </select>
        </div>

        <div className="flex items-center gap-2">
          <label className="text-xs uppercase tracking-wider text-[var(--color-ink-muted)]">
            Outcome
          </label>
          <select
            value={filters.outcome}
            onChange={(e) => onChange({ outcome: e.target.value as Outcome })}
            className="rounded-pill border border-[var(--color-hairline)] bg-[var(--color-bg)] px-3 py-1.5 text-sm text-[var(--color-ink)] focus:border-[var(--color-ink)] focus:outline-none"
          >
            {OUTCOMES.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>

        <div className="flex items-center gap-1 rounded-pill border border-[var(--color-hairline)] bg-[var(--color-bg)] p-1">
          {RANGES.map((r) => (
            <button
              key={r.value}
              type="button"
              onClick={() => onChange({ range: r.value })}
              className={`rounded-pill px-3 py-1 text-xs font-medium transition-colors ${
                filters.range === r.value
                  ? 'bg-[var(--color-ink)] text-[var(--color-bg)]'
                  : 'text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]'
              }`}
            >
              {r.label}
            </button>
          ))}
        </div>

        {hasAnyFilter && (
          <button
            type="button"
            onClick={onClear}
            className="ml-auto inline-flex items-center gap-1 rounded-pill px-3 py-1.5 text-xs text-[var(--color-ink-muted)] transition-colors hover:bg-[var(--color-bg-subtle)] hover:text-[var(--color-ink)]"
          >
            <X className="h-3 w-3" aria-hidden="true" />
            Clear filters
          </button>
        )}
      </div>
    </div>
  );
}

function shortenModel(m: string): string {
  // claude-haiku-4-5-20251001 → haiku-4-5
  // claude-sonnet-4-6 → sonnet-4-6
  // claude-opus-4-7 → opus-4-7
  return m.replace(/^claude-/, '').replace(/-\d{8}$/, '');
}
