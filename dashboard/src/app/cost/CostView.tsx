'use client';

import { useCallback, useMemo, useState } from 'react';
import { Download } from 'lucide-react';

import { ConnectionLossBanner } from '@/components/panels/ConnectionLossBanner';
import { CostAlertsConfig } from '@/components/panels/CostAlertsConfig';
import { CostByGroupTable } from '@/components/panels/CostByGroupTable';
import { CostByModelChart } from '@/components/panels/CostByModelChart';
import { CostHeroStat } from '@/components/panels/CostHeroStat';
import { usePoll } from '@/hooks/usePoll';
import {
  type CostDaily,
  type Group,
  getCostDaily,
  getGroups,
} from '@/lib/nanoclaw';

/**
 * Client view for the Cost route. Polls /api/cost/daily at two cadences
 * (7d window for the hero, 30d for the chart) and /api/groups to find the
 * main group whose container_config holds the alerts threshold. CSV / JSON
 * export buttons live in the header.
 */
export function CostView() {
  // Reload counter for the alerts panel — incremented after a successful
  // PATCH so the groups poll re-fires immediately rather than waiting for
  // the next 60s tick.
  const [reloadKey, setReloadKey] = useState(0);

  const fetch7d = useCallback(() => getCostDaily({ days: 7 }), []);
  const fetch30d = useCallback(() => getCostDaily({ days: 30 }), []);
  const fetchGroupsFn = useCallback(() => getGroups(), [reloadKey]);

  const { data: rows7d, error: err7d } = usePoll<CostDaily[]>(fetch7d, 30_000);
  const { data: rows30d, error: err30d } = usePoll<CostDaily[]>(
    fetch30d,
    60_000,
  );
  const { data: groups, error: errGroups } = usePoll<Group[]>(
    fetchGroupsFn,
    60_000,
  );

  const mainGroup = useMemo(() => groups?.find((g) => g.is_main) ?? null, [
    groups,
  ]);

  const budgetCents = useMemo(() => {
    if (!mainGroup) return null;
    const cfg = mainGroup.container_config as Record<string, unknown> | null;
    const ca = cfg?.['costAlerts'];
    if (ca && typeof ca === 'object') {
      const v = (ca as Record<string, unknown>).dailyBudgetCents;
      if (typeof v === 'number') return v;
    }
    return null;
  }, [mainGroup]);

  const csvHref = useMemo(() => buildCsvHref(rows30d ?? []), [rows30d]);
  const jsonHref = useMemo(() => buildJsonHref(rows30d ?? []), [rows30d]);
  const downloadStem = `cost-summary-${new Date().toISOString().slice(0, 10)}`;

  const firstError = err7d ?? err30d ?? errGroups ?? null;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-medium tracking-tight text-[var(--color-ink)]">
            Cost
          </h1>
          <p className="mt-2 text-sm text-[var(--color-ink-muted)]">
            Spend across all agent turns. Hero polled every 30s; charts every
            60s.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <a
            href={csvHref}
            download={`${downloadStem}.csv`}
            className="inline-flex items-center gap-2 rounded-pill border border-[var(--color-hairline)] bg-[var(--color-bg)] px-4 py-2 text-sm text-[var(--color-ink)] transition-colors hover:bg-[var(--color-bg-subtle)]"
          >
            <Download className="h-4 w-4" aria-hidden="true" />
            CSV
          </a>
          <a
            href={jsonHref}
            download={`${downloadStem}.json`}
            className="inline-flex items-center gap-2 rounded-pill border border-[var(--color-hairline)] bg-[var(--color-bg)] px-4 py-2 text-sm text-[var(--color-ink)] transition-colors hover:bg-[var(--color-bg-subtle)]"
          >
            <Download className="h-4 w-4" aria-hidden="true" />
            JSON
          </a>
        </div>
      </div>

      {firstError && <ConnectionLossBanner error={firstError} />}

      <CostHeroStat rows={rows7d ?? []} budgetCents={budgetCents} />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <CostByModelChart rows={rows30d ?? []} />
        </div>
        <div className="lg:col-span-1">
          <CostAlertsConfig
            mainGroup={mainGroup}
            onSaved={() => setReloadKey((k) => k + 1)}
          />
        </div>
      </div>

      <CostByGroupTable />
    </div>
  );
}

function buildCsvHref(rows: CostDaily[]): string {
  const header = 'day,model,cents,turns,in_tok,out_tok';
  const lines = rows.map((r) => {
    const dollars = ((r.cents ?? 0) / 100).toFixed(2);
    return [
      escapeCsv(r.day),
      escapeCsv(r.model),
      dollars,
      String(r.turns ?? 0),
      String(r.in_tok ?? 0),
      String(r.out_tok ?? 0),
    ].join(',');
  });
  const body = [header, ...lines].join('\n');
  return `data:text/csv;charset=utf-8,${encodeURIComponent(body)}`;
}

function buildJsonHref(rows: CostDaily[]): string {
  const body = JSON.stringify(rows, null, 2);
  return `data:application/json;charset=utf-8,${encodeURIComponent(body)}`;
}

function escapeCsv(field: string): string {
  if (/[",\n\r]/.test(field)) {
    return `"${field.replace(/"/g, '""')}"`;
  }
  return field;
}
