'use client';

import { Calendar } from 'lucide-react';

import type { CostDaily } from '@/lib/nanoclaw';
import { formatCostCents, formatTokens } from '@/lib/format';

interface Props {
  rows: CostDaily[];
  selectedDay: string | null;
  onSelectDay: (day: string | null) => void;
  /**
   * 'cost' (default) shows per-day dollar spend; 'usage' shows per-day total
   * tokens (input + output) — subscription/oauth deployments.
   */
  mode?: 'cost' | 'usage';
}

interface DayAggregate {
  day: string;
  value: number;
  turns: number;
}

/**
 * Left rail showing per-day totals (turn count + headline metric) aggregated
 * across all models from /api/cost/daily. The metric is dollar spend in
 * 'cost' mode and total tokens (input + output) in 'usage' mode. Clicking a
 * day filters the feed to that day; clicking the same day again clears it.
 *
 * Empty state: when no historical telemetry exists yet (turns table just
 * started filling), the rail shows the start moment so the operator
 * understands why there's no historical data.
 */
export function DailyRollupRail({
  rows,
  selectedDay,
  onSelectDay,
  mode = 'cost',
}: Props) {
  const usage = mode === 'usage';
  const fmt = usage ? formatTokens : formatCostCents;
  // Aggregate per-day across all models
  const byDay = new Map<string, DayAggregate>();
  for (const r of rows) {
    const metric = usage ? (r.in_tok ?? 0) + (r.out_tok ?? 0) : r.cents ?? 0;
    const existing = byDay.get(r.day);
    if (existing) {
      existing.value += metric;
      existing.turns += r.turns ?? 0;
    } else {
      byDay.set(r.day, { day: r.day, value: metric, turns: r.turns ?? 0 });
    }
  }
  const days = Array.from(byDay.values()).sort((a, b) =>
    a.day < b.day ? 1 : -1,
  );

  return (
    <aside className="w-full lg:w-56 lg:flex-shrink-0">
      <div className="rounded-2xl border border-[var(--color-hairline)] bg-[var(--color-bg)] p-4">
        <div className="mb-3 flex items-center gap-2 text-xs uppercase tracking-wider text-[var(--color-ink-muted)]">
          <Calendar className="h-3.5 w-3.5" aria-hidden="true" />
          Daily rollup
        </div>

        {days.length === 0 ? (
          <p className="text-xs text-[var(--color-ink-muted)]">
            No historical data yet. Telemetry capture started on the first
            agent_turn after Wave 2 deploy — the first reply will populate
            this list.
          </p>
        ) : (
          <ul className="space-y-1">
            {days.map((d) => {
              const isSelected = d.day === selectedDay;
              return (
                <li key={d.day}>
                  <button
                    type="button"
                    onClick={() => onSelectDay(isSelected ? null : d.day)}
                    aria-pressed={isSelected}
                    className={`flex w-full items-center justify-between gap-2 rounded-xl px-3 py-2 text-left text-xs transition-colors ${
                      isSelected
                        ? 'bg-[var(--color-ink)] text-[var(--color-bg)]'
                        : 'hover:bg-[var(--color-bg-subtle)]'
                    }`}
                  >
                    <span
                      className={`font-medium ${
                        isSelected ? '' : 'text-[var(--color-ink)]'
                      }`}
                    >
                      {formatDay(d.day)}
                    </span>
                    <span
                      className={`flex items-baseline gap-2 ${
                        isSelected
                          ? 'opacity-90'
                          : 'text-[var(--color-ink-muted)]'
                      }`}
                    >
                      <span>{d.turns}</span>
                      <span>·</span>
                      <span>{fmt(d.value)}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </aside>
  );
}

function formatDay(iso: string): string {
  // iso is YYYY-MM-DD. Return 'May 5' style.
  const [, m, d] = iso.split('-').map((p) => parseInt(p, 10));
  const months = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ];
  if (!m || !d) return iso;
  return `${months[m - 1]} ${d}`;
}
