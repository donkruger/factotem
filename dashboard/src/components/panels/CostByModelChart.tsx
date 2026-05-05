'use client';

import { useMemo } from 'react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts';

import { Card } from '@/components/ui/Card';
import type { CostDaily } from '@/lib/nanoclaw';
import { formatCostCents } from '@/lib/format';

interface Props {
  rows: CostDaily[];
}

interface PivotedRow {
  day: string;
  [model: string]: number | string;
}

/**
 * 30-day stacked bar chart: x = day, y = cents, stacked by model.
 *
 * `/api/cost/daily` returns one row per (day, model). We pivot client-side
 * so each chart row carries one cell per model. Models are derived from
 * the data and rendered with stable colours via `modelColor`.
 */
export function CostByModelChart({ rows }: Props) {
  const { pivoted, models } = useMemo(() => pivotRows(rows), [rows]);

  if (rows.length === 0) {
    return (
      <Card>
        <div className="space-y-2">
          <p className="text-sm font-medium text-[var(--color-ink)]">
            Cost by model
          </p>
          <p className="text-xs text-[var(--color-ink-muted)]">
            No cost data yet — telemetry began with Wave 2 deploy. The first
            agent reply will populate this chart within 5s.
          </p>
        </div>
      </Card>
    );
  }

  return (
    <Card>
      <div className="space-y-4">
        <div>
          <p className="text-sm font-medium text-[var(--color-ink)]">
            Cost by model
          </p>
          <p className="text-xs text-[var(--color-ink-muted)]">
            Last 30 days, stacked by model.
          </p>
        </div>

        <ResponsiveContainer width="100%" height={280}>
          <BarChart
            data={pivoted}
            margin={{ top: 8, right: 8, left: 0, bottom: 0 }}
          >
            <CartesianGrid strokeDasharray="3 3" stroke="var(--color-hairline)" />
            <XAxis
              dataKey="day"
              tick={{ fill: 'var(--color-ink-muted)', fontSize: 11 }}
              tickFormatter={shortenDay}
              stroke="var(--color-hairline)"
            />
            <YAxis
              tickFormatter={(v) => formatCostCents(Number(v))}
              tick={{ fill: 'var(--color-ink-muted)', fontSize: 11 }}
              stroke="var(--color-hairline)"
              width={64}
            />
            <Tooltip
              content={<CostTooltip />}
              cursor={{ fill: 'var(--color-bg-subtle)' }}
            />
            <Legend
              wrapperStyle={{ fontSize: 12 }}
              formatter={(value: string) => (
                <span className="text-[var(--color-ink-muted)]">{value}</span>
              )}
            />
            {models.map((m) => (
              <Bar
                key={m}
                dataKey={m}
                stackId="cost"
                fill={modelColor(m)}
                name={shortenModel(m)}
              />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
    </Card>
  );
}

interface TooltipPayloadEntry {
  name?: string;
  value?: number | string;
  color?: string;
  dataKey?: string;
}

interface TooltipProps {
  active?: boolean;
  payload?: TooltipPayloadEntry[];
  label?: string;
}

function CostTooltip({ active, payload, label }: TooltipProps) {
  if (!active || !payload || payload.length === 0) return null;
  const total = payload.reduce(
    (sum, entry) => sum + (Number(entry.value) || 0),
    0,
  );
  return (
    <div className="rounded-xl border border-[var(--color-hairline)] bg-[var(--color-bg)] px-3 py-2 text-xs shadow-[var(--shadow-2)]">
      <p className="mb-1 font-medium text-[var(--color-ink)]">{label}</p>
      <ul className="space-y-0.5">
        {payload.map((entry, i) => (
          <li
            key={`${entry.dataKey ?? entry.name ?? i}-${i}`}
            className="flex items-center justify-between gap-3"
          >
            <span className="flex items-center gap-1.5">
              <span
                className="h-2 w-2 rounded-sm"
                style={{ backgroundColor: entry.color }}
              />
              <span className="text-[var(--color-ink-muted)]">
                {entry.name}
              </span>
            </span>
            <span className="font-medium text-[var(--color-ink)]">
              {formatCostCents(Number(entry.value) || 0)}
            </span>
          </li>
        ))}
        <li className="mt-1 flex items-center justify-between gap-3 border-t border-[var(--color-hairline)] pt-1">
          <span className="text-[var(--color-ink-muted)]">Total</span>
          <span className="font-medium text-[var(--color-ink)]">
            {formatCostCents(total)}
          </span>
        </li>
      </ul>
    </div>
  );
}

function pivotRows(rows: CostDaily[]): {
  pivoted: PivotedRow[];
  models: string[];
} {
  const byDay = new Map<string, PivotedRow>();
  const modelSet = new Set<string>();
  for (const r of rows) {
    modelSet.add(r.model);
    let bucket = byDay.get(r.day);
    if (!bucket) {
      bucket = { day: r.day };
      byDay.set(r.day, bucket);
    }
    bucket[r.model] = ((bucket[r.model] as number | undefined) ?? 0) + (r.cents ?? 0);
  }
  const models = Array.from(modelSet).sort();
  // Ensure every day has every model key (recharts is more forgiving with
  // explicit zeroes than missing keys when stacking).
  const pivoted = Array.from(byDay.values())
    .map((row) => {
      for (const m of models) {
        if (typeof row[m] !== 'number') row[m] = 0;
      }
      return row;
    })
    .sort((a, b) => (a.day < b.day ? -1 : 1));
  return { pivoted, models };
}

/** Stable colour map for the v1 model set. */
export function modelColor(m: string): string {
  if (m.includes('haiku')) return '#80cbc4';
  if (m.includes('sonnet')) return '#6a00ff';
  if (m.includes('opus')) return '#ff7a3a';
  return '#86868b';
}

/**
 * Strip `claude-` prefix and a trailing `-YYYYMMDD` date stamp. Mirrors
 * the helper in ActivityFilters so the labels read identically across
 * the two panels.
 */
export function shortenModel(m: string): string {
  return m.replace(/^claude-/, '').replace(/-\d{8}$/, '');
}

function shortenDay(iso: string): string {
  // YYYY-MM-DD → MM/DD for tighter axis labels at 30-day width.
  const parts = iso.split('-');
  if (parts.length !== 3) return iso;
  return `${parts[1]}/${parts[2]}`;
}
