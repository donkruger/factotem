'use client';

import { useMemo } from 'react';

import { Card } from '@/components/ui/Card';
import type { CostDaily } from '@/lib/nanoclaw';
import { formatCostCents, formatTokens } from '@/lib/format';

interface Props {
  rows: CostDaily[];
  budgetCents: number | null;
  /**
   * 'cost' (default) shows today's dollar spend + budget meter — api-key
   * deployments. 'usage' shows today's token volume + turn count, with no
   * dollar figures — subscription/oauth deployments (see `isUsageMode`).
   */
  mode?: 'cost' | 'usage';
}

interface DayPoint {
  day: string;
  value: number;
}

/**
 * Hero strip for the Cost/Usage panel: today's headline metric as a big
 * number on the left with a 7-day sparkline on the right. Aggregates rows
 * (which arrive pivoted by day+model) by day so the sparkline reflects the
 * per-day total across all models.
 *
 * In 'cost' mode the metric is dollar spend (+ budget %). In 'usage' mode it
 * is total tokens (input + output) with a turn count — dollars and the
 * budget meter are omitted because they're meaningless on a subscription
 * token.
 */
export function CostHeroStat({ rows, budgetCents, mode = 'cost' }: Props) {
  const usage = mode === 'usage';
  const days = useMemo(() => buildLast7Days(rows, usage), [rows, usage]);
  const todayValue = days.length > 0 ? days[days.length - 1].value : 0;
  const todayTurns = useMemo(() => sumTurnsForToday(rows), [rows]);

  const pct =
    !usage && budgetCents !== null && budgetCents > 0
      ? Math.round((todayValue / budgetCents) * 100)
      : null;

  const pctColor =
    pct === null
      ? ''
      : pct <= 50
        ? 'text-emerald-600 dark:text-emerald-400'
        : pct <= 80
          ? 'text-amber-600 dark:text-amber-400'
          : 'text-red-600 dark:text-red-400';

  return (
    <Card>
      <div className="flex flex-col gap-6 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-2">
          <p className="text-xs uppercase tracking-wider text-[var(--color-ink-muted)]">
            Today
          </p>
          <p className="text-5xl font-medium text-[var(--color-ink)]">
            {usage ? formatTokens(todayValue) : formatCostCents(todayValue)}
          </p>
          <p className="text-sm text-[var(--color-ink-muted)]">
            {usage ? (
              <>
                tokens in + out
                {' · '}
                <span className="font-medium text-[var(--color-ink)]">
                  {todayTurns} turn{todayTurns === 1 ? '' : 's'}
                </span>
              </>
            ) : budgetCents !== null && pct !== null ? (
              <>
                of {formatCostCents(budgetCents)} daily budget
                {' · '}
                <span className={`font-medium ${pctColor}`}>{pct}% used</span>
              </>
            ) : (
              <>no budget configured — set one via the Alerts panel below</>
            )}
          </p>
        </div>

        <Sparkline points={days} label={usage ? '7-day token sparkline' : '7-day cost sparkline'} />
      </div>
    </Card>
  );
}

/** Sum of turns across all of today's day+model rows. */
function sumTurnsForToday(rows: CostDaily[]): number {
  const today = new Date().toISOString().slice(0, 10);
  let turns = 0;
  for (const r of rows) if (r.day === today) turns += r.turns ?? 0;
  return turns;
}

const SPARK_W = 120;
const SPARK_H = 40;
const SPARK_PAD = 4;

function Sparkline({ points, label }: { points: DayPoint[]; label: string }) {
  // Need at least two points to draw a polyline. If we have fewer, render an
  // empty axis to keep the layout stable.
  if (points.length < 2) {
    return (
      <svg
        width={SPARK_W}
        height={SPARK_H}
        role="img"
        aria-label={label}
        className="flex-shrink-0"
      >
        <line
          x1={SPARK_PAD}
          y1={SPARK_H - SPARK_PAD}
          x2={SPARK_W - SPARK_PAD}
          y2={SPARK_H - SPARK_PAD}
          stroke="var(--color-hairline)"
          strokeWidth={1}
        />
      </svg>
    );
  }

  const max = Math.max(...points.map((p) => p.value), 1);
  const stepX =
    points.length > 1
      ? (SPARK_W - 2 * SPARK_PAD) / (points.length - 1)
      : 0;

  const coords = points.map((p, i) => {
    const x = SPARK_PAD + i * stepX;
    const yScale =
      max > 0 ? (p.value / max) * (SPARK_H - 2 * SPARK_PAD) : 0;
    const y = SPARK_H - SPARK_PAD - yScale;
    return [x, y] as const;
  });

  const path = coords.map(([x, y]) => `${x},${y}`).join(' ');
  const [todayX, todayY] = coords[coords.length - 1];

  return (
    <svg
      width={SPARK_W}
      height={SPARK_H}
      role="img"
      aria-label="7-day cost sparkline"
      className="flex-shrink-0"
    >
      <polyline
        points={path}
        fill="none"
        stroke="var(--color-accent)"
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <circle
        cx={todayX}
        cy={todayY}
        r={2.5}
        fill="var(--color-accent)"
      />
    </svg>
  );
}

/**
 * Build a contiguous 7-day window ending today from the (sparse) rows
 * returned by /api/cost/daily. The per-day value is cents in cost mode and
 * total tokens (input + output) in usage mode. Days with no telemetry get 0
 * so the sparkline is continuous rather than jumping over gaps.
 */
function buildLast7Days(rows: CostDaily[], usage: boolean): DayPoint[] {
  const totals = new Map<string, number>();
  for (const r of rows) {
    const metric = usage ? (r.in_tok ?? 0) + (r.out_tok ?? 0) : r.cents ?? 0;
    totals.set(r.day, (totals.get(r.day) ?? 0) + metric);
  }
  const out: DayPoint[] = [];
  const today = new Date();
  for (let i = 6; i >= 0; i--) {
    const d = new Date(
      Date.UTC(
        today.getUTCFullYear(),
        today.getUTCMonth(),
        today.getUTCDate() - i,
      ),
    );
    const iso = d.toISOString().slice(0, 10);
    out.push({ day: iso, value: totals.get(iso) ?? 0 });
  }
  return out;
}
