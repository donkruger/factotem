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

  const alertThresholds = useMemo<number[]>(() => {
    if (!mainGroup) return [];
    const cfg = mainGroup.container_config as Record<string, unknown> | null;
    const ca = cfg?.['costAlerts'];
    if (ca && typeof ca === 'object') {
      const arr = (ca as Record<string, unknown>).alertThresholds;
      if (Array.isArray(arr))
        return arr.filter((n): n is number => typeof n === 'number');
    }
    return [];
  }, [mainGroup]);

  const exportCtx = useMemo<ExportContext>(
    () => ({
      generatedAt: new Date().toISOString(),
      todayIso: new Date().toISOString().slice(0, 10),
      rows7d: rows7d ?? [],
      rows30d: rows30d ?? [],
      budgetCents,
      alertThresholds,
      mainGroupName: mainGroup?.name ?? null,
    }),
    [rows7d, rows30d, budgetCents, alertThresholds, mainGroup],
  );

  const csvHref = useMemo(() => buildCsvHref(exportCtx), [exportCtx]);
  const jsonHref = useMemo(() => buildJsonHref(exportCtx), [exportCtx]);
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

interface ExportContext {
  generatedAt: string;
  todayIso: string;
  rows7d: CostDaily[];
  rows30d: CostDaily[];
  budgetCents: number | null;
  alertThresholds: number[];
  mainGroupName: string | null;
}

function sumCents(rows: CostDaily[], dayFilter?: string): number {
  let total = 0;
  for (const r of rows) {
    if (dayFilter && r.day !== dayFilter) continue;
    total += r.cents ?? 0;
  }
  return total;
}

function modelBreakdown(rows: CostDaily[]): Record<
  string,
  { cents: number; turns: number; in_tok: number; out_tok: number }
> {
  const out: Record<
    string,
    { cents: number; turns: number; in_tok: number; out_tok: number }
  > = {};
  for (const r of rows) {
    const k = r.model || 'unknown';
    if (!out[k]) out[k] = { cents: 0, turns: 0, in_tok: 0, out_tok: 0 };
    out[k].cents += r.cents ?? 0;
    out[k].turns += r.turns ?? 0;
    out[k].in_tok += r.in_tok ?? 0;
    out[k].out_tok += r.out_tok ?? 0;
  }
  return out;
}

function buildCsvHref(ctx: ExportContext): string {
  const todayCents = sumCents(ctx.rows30d, ctx.todayIso);
  const sevenDayCents = sumCents(ctx.rows7d);
  const thirtyDayCents = sumCents(ctx.rows30d);
  const pctUsed =
    ctx.budgetCents && ctx.budgetCents > 0
      ? Math.round((todayCents / ctx.budgetCents) * 100)
      : null;

  // Comment header (most CSV consumers skip `#` prefixes; spreadsheets
  // may show them as a single column — operators can ignore).
  const meta = [
    `# Cost summary export`,
    `# generated_at=${ctx.generatedAt}`,
    `# today=${ctx.todayIso}`,
    `# main_group=${ctx.mainGroupName ?? '(none)'}`,
    `# today_cents=${todayCents}  today_dollars=${(todayCents / 100).toFixed(2)}`,
    `# 7d_cents=${sevenDayCents}  7d_dollars=${(sevenDayCents / 100).toFixed(2)}`,
    `# 30d_cents=${thirtyDayCents}  30d_dollars=${(thirtyDayCents / 100).toFixed(2)}`,
    `# budget_cents=${ctx.budgetCents ?? 'not_configured'}`,
    `# budget_dollars=${ctx.budgetCents !== null ? (ctx.budgetCents / 100).toFixed(2) : 'not_configured'}`,
    `# pct_used_today=${pctUsed ?? 'n/a'}`,
    `# alert_thresholds_pct=${ctx.alertThresholds.length ? ctx.alertThresholds.join(';') : 'none'}`,
  ];

  // Per-model 30d totals as a compact section.
  const byModel = modelBreakdown(ctx.rows30d);
  const modelLines = ['#', '# 30d totals by model:'];
  for (const [model, m] of Object.entries(byModel).sort((a, b) =>
    a[0] < b[0] ? -1 : 1,
  )) {
    modelLines.push(
      `# model_${escapeCsvComment(model)} cents=${m.cents} dollars=${(m.cents / 100).toFixed(2)} turns=${m.turns}`,
    );
  }

  // Daily breakdown section.
  const header = 'day,model,cents,dollars,turns,in_tok,out_tok';
  const lines = ctx.rows30d.map((r) => {
    const dollars = ((r.cents ?? 0) / 100).toFixed(2);
    return [
      escapeCsv(r.day),
      escapeCsv(r.model),
      String(r.cents ?? 0),
      dollars,
      String(r.turns ?? 0),
      String(r.in_tok ?? 0),
      String(r.out_tok ?? 0),
    ].join(',');
  });

  const body = [...meta, ...modelLines, '#', '# daily breakdown:', header, ...lines].join('\n');
  return `data:text/csv;charset=utf-8,${encodeURIComponent(body)}`;
}

function buildJsonHref(ctx: ExportContext): string {
  const todayCents = sumCents(ctx.rows30d, ctx.todayIso);
  const sevenDayCents = sumCents(ctx.rows7d);
  const thirtyDayCents = sumCents(ctx.rows30d);
  const pctUsed =
    ctx.budgetCents && ctx.budgetCents > 0
      ? Math.round((todayCents / ctx.budgetCents) * 100)
      : null;

  const payload = {
    generated_at: ctx.generatedAt,
    deployment: {
      today: ctx.todayIso,
      main_group: ctx.mainGroupName,
      budget_cents: ctx.budgetCents,
      budget_dollars:
        ctx.budgetCents !== null
          ? Number((ctx.budgetCents / 100).toFixed(2))
          : null,
      alert_thresholds_pct: ctx.alertThresholds,
    },
    today_summary: {
      spent_cents: todayCents,
      spent_dollars: Number((todayCents / 100).toFixed(2)),
      budget_pct_used: pctUsed,
    },
    totals: {
      window_7d_cents: sevenDayCents,
      window_7d_dollars: Number((sevenDayCents / 100).toFixed(2)),
      window_30d_cents: thirtyDayCents,
      window_30d_dollars: Number((thirtyDayCents / 100).toFixed(2)),
      model_breakdown_30d: modelBreakdown(ctx.rows30d),
    },
    daily_breakdown_30d: ctx.rows30d.map((r) => ({
      ...r,
      dollars: Number(((r.cents ?? 0) / 100).toFixed(4)),
    })),
  };
  const body = JSON.stringify(payload, null, 2);
  return `data:application/json;charset=utf-8,${encodeURIComponent(body)}`;
}

function escapeCsv(field: string): string {
  if (/[",\n\r]/.test(field)) {
    return `"${field.replace(/"/g, '""')}"`;
  }
  return field;
}

// CSV comment line; strip newlines + leading-# we'd otherwise emit.
function escapeCsvComment(field: string): string {
  return field.replace(/[\r\n]/g, ' ').replace(/^#+/, '');
}
