'use client';

import { useEffect, useMemo, useState } from 'react';

import { Card } from '@/components/ui/Card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
} from '@/components/ui/Table';
import type { Turn } from '@/lib/nanoclaw';
import { getTurns } from '@/lib/nanoclaw';
import { formatCostCents } from '@/lib/format';

import { shortenModel } from './CostByModelChart';

interface GroupAggregate {
  group: string;
  todayCents: number;
  sevenDayCents: number;
  thirtyDayCents: number;
  topModel: string | null;
}

/**
 * Per-group cost breakdown. /api/cost/daily aggregates by day+model only,
 * so this component fetches up to 5000 raw turns from the last 30 days
 * and rolls them up client-side. Sorted by 30-day spend descending.
 */
export function CostByGroupTable() {
  const [turns, setTurns] = useState<Turn[] | null>(null);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    let cancelled = false;
    const since = new Date(
      Date.now() - 30 * 24 * 60 * 60 * 1000,
    ).toISOString();
    getTurns({ since, limit: 5000 })
      .then((rows) => {
        if (!cancelled) setTurns(rows);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err as Error);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const aggregates = useMemo(
    () => (turns ? rollupByGroup(turns) : null),
    [turns],
  );

  return (
    <Card>
      <div className="space-y-4">
        <div>
          <p className="text-sm font-medium text-[var(--color-ink)]">
            Cost by group
          </p>
          <p className="text-xs text-[var(--color-ink-muted)]">
            Rolled up from raw turns over the last 30 days.
          </p>
        </div>

        {error && (
          <p className="text-xs text-red-700 dark:text-red-300">
            Failed to load turns: {error.message}
          </p>
        )}

        {!turns && !error && (
          <p className="text-sm text-[var(--color-ink-muted)]">
            Loading…
          </p>
        )}

        {aggregates && aggregates.length === 0 && (
          <p className="text-sm text-[var(--color-ink-muted)]">
            No turns recorded in the last 30 days.
          </p>
        )}

        {aggregates && aggregates.length > 0 && (
          <Table>
            <TableHead>
              <TableRow>
                <TableCell header>Group</TableCell>
                <TableCell header className="text-right">
                  Today
                </TableCell>
                <TableCell header className="text-right">
                  7d
                </TableCell>
                <TableCell header className="text-right">
                  30d
                </TableCell>
                <TableCell header>Top model</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {aggregates.map((row) => (
                <TableRow key={row.group}>
                  <TableCell className="font-medium">{row.group}</TableCell>
                  <TableCell className="text-right font-mono text-xs">
                    {formatCostCents(row.todayCents)}
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs">
                    {formatCostCents(row.sevenDayCents)}
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs">
                    {formatCostCents(row.thirtyDayCents)}
                  </TableCell>
                  <TableCell className="text-xs text-[var(--color-ink-muted)]">
                    {row.topModel ? shortenModel(row.topModel) : '—'}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </Card>
  );
}

function rollupByGroup(turns: Turn[]): GroupAggregate[] {
  const now = Date.now();
  const todayMidnight = Date.UTC(
    new Date(now).getUTCFullYear(),
    new Date(now).getUTCMonth(),
    new Date(now).getUTCDate(),
  );
  const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;
  const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000;

  interface Bucket {
    todayCents: number;
    sevenDayCents: number;
    thirtyDayCents: number;
    modelCounts: Map<string, number>;
  }
  const buckets = new Map<string, Bucket>();

  for (const t of turns) {
    const ts = Date.parse(t.started_at);
    if (!Number.isFinite(ts)) continue;
    if (ts < thirtyDaysAgo) continue;
    const key = t.group_folder || '(unknown)';
    let b = buckets.get(key);
    if (!b) {
      b = {
        todayCents: 0,
        sevenDayCents: 0,
        thirtyDayCents: 0,
        modelCounts: new Map(),
      };
      buckets.set(key, b);
    }
    const cents = t.est_cost_cents ?? 0;
    b.thirtyDayCents += cents;
    if (ts >= sevenDaysAgo) b.sevenDayCents += cents;
    if (ts >= todayMidnight) b.todayCents += cents;
    if (t.model) {
      b.modelCounts.set(t.model, (b.modelCounts.get(t.model) ?? 0) + 1);
    }
  }

  const out: GroupAggregate[] = [];
  for (const [group, b] of buckets.entries()) {
    let topModel: string | null = null;
    let topCount = -1;
    for (const [m, c] of b.modelCounts.entries()) {
      if (c > topCount) {
        topCount = c;
        topModel = m;
      }
    }
    out.push({
      group,
      todayCents: b.todayCents,
      sevenDayCents: b.sevenDayCents,
      thirtyDayCents: b.thirtyDayCents,
      topModel,
    });
  }

  out.sort((a, b) => b.thirtyDayCents - a.thirtyDayCents);
  return out;
}
