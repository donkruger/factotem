'use client';

import { useEffect, useState } from 'react';
import { Bell, Send } from 'lucide-react';

import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import type { Group } from '@/lib/nanoclaw';
import {
  groupVersionOf,
  patchGroup,
  postCostTestAlert,
} from '@/lib/nanoclaw';

interface Props {
  /** Operator's main group — alerts config lives in its container_config. */
  mainGroup: Group | null;
  /** Called after a successful save so the parent reloads /api/groups. */
  onSaved: () => void;
}

interface AlertsConfig {
  dailyBudgetCents: number;
  alertThresholds: number[];
}

const DEFAULT_BUDGET_CENTS = 500; // $5.00
const THRESHOLD_OPTIONS = [50, 80, 100] as const;

/**
 * Right-rail card on the Cost panel: edit the daily budget threshold,
 * pick which percent thresholds should fire, and send a test alert.
 *
 * Persists into `mainGroup.container_config.costAlerts` via PATCH /api/groups
 * with optimistic-concurrency via If-Match.
 */
export function CostAlertsConfig({ mainGroup, onSaved }: Props) {
  const [budgetDollars, setBudgetDollars] = useState<string>('5.00');
  const [thresholds, setThresholds] = useState<number[]>([50, 80, 100]);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [saveMsg, setSaveMsg] = useState<{
    kind: 'ok' | 'err';
    text: string;
  } | null>(null);
  const [testMsg, setTestMsg] = useState<{
    kind: 'ok' | 'err';
    text: string;
  } | null>(null);

  // Hydrate local state from mainGroup whenever it lands or changes.
  useEffect(() => {
    if (!mainGroup) return;
    const cfg = readAlertsConfig(mainGroup);
    setBudgetDollars(centsToDollarsInput(cfg.dailyBudgetCents));
    setThresholds(cfg.alertThresholds);
  }, [mainGroup]);

  if (!mainGroup) {
    return (
      <Card>
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Bell
              className="h-4 w-4 text-[var(--color-accent)]"
              aria-hidden="true"
            />
            <p className="text-sm font-medium text-[var(--color-ink)]">
              Cost alerts
            </p>
          </div>
          <p className="text-xs text-[var(--color-ink-muted)]">
            No main group registered yet.
          </p>
        </div>
      </Card>
    );
  }

  const budgetCents = parseDollarsToCents(budgetDollars);
  const budgetValid = budgetCents !== null && budgetCents >= 0;

  const onToggleThreshold = (pct: number) => {
    setThresholds((prev) =>
      prev.includes(pct)
        ? prev.filter((p) => p !== pct)
        : [...prev, pct].sort((a, b) => a - b),
    );
  };

  const onSave = async () => {
    if (!mainGroup || !budgetValid) return;
    setSaving(true);
    setSaveMsg(null);
    try {
      const body: AlertsConfig = {
        dailyBudgetCents: budgetCents!,
        alertThresholds: thresholds,
      };
      await patchGroup(
        mainGroup.jid,
        { container_config: { costAlerts: body } },
        groupVersionOf(mainGroup),
      );
      setSaveMsg({ kind: 'ok', text: 'Saved.' });
      onSaved();
    } catch (err) {
      setSaveMsg({
        kind: 'err',
        text: `Save failed: ${(err as Error).message}`,
      });
    } finally {
      setSaving(false);
    }
  };

  const onTest = async () => {
    if (!budgetValid) return;
    setTesting(true);
    setTestMsg(null);
    try {
      const lowestThreshold = thresholds.length > 0 ? thresholds[0] : 50;
      const spent = Math.round(((budgetCents ?? 0) * lowestThreshold) / 100);
      const res = await postCostTestAlert({
        threshold_pct: lowestThreshold,
        spent_cents: spent,
        budget_cents: budgetCents ?? 0,
      });
      setTestMsg({
        kind: 'ok',
        text: `Test alert dropped into ${res.target_folder}.`,
      });
    } catch (err) {
      setTestMsg({
        kind: 'err',
        text: `Test failed: ${(err as Error).message}`,
      });
    } finally {
      setTesting(false);
    }
  };

  return (
    <Card>
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <Bell
            className="h-4 w-4 text-[var(--color-accent)]"
            aria-hidden="true"
          />
          <p className="text-sm font-medium text-[var(--color-ink)]">
            Cost alerts
          </p>
        </div>

        <div className="space-y-2">
          <label
            htmlFor="cost-alerts-budget"
            className="block text-xs uppercase tracking-wider text-[var(--color-ink-muted)]"
          >
            Daily budget (USD)
          </label>
          <div className="flex items-center gap-2">
            <span className="text-[var(--color-ink-muted)]">$</span>
            <input
              id="cost-alerts-budget"
              type="number"
              inputMode="decimal"
              step="0.01"
              min="0"
              value={budgetDollars}
              onChange={(e) => setBudgetDollars(e.target.value)}
              className="w-32 rounded-xl border border-[var(--color-hairline)] bg-[var(--color-bg)] px-3 py-1.5 text-sm text-[var(--color-ink)] focus:border-[var(--color-ink)] focus:outline-none"
            />
          </div>
          {!budgetValid && (
            <p className="text-xs text-red-700 dark:text-red-300">
              Enter a non-negative dollar amount.
            </p>
          )}
        </div>

        <div className="space-y-2">
          <p className="text-xs uppercase tracking-wider text-[var(--color-ink-muted)]">
            Fire at thresholds
          </p>
          <div className="flex flex-wrap items-center gap-3">
            {THRESHOLD_OPTIONS.map((pct) => {
              const checked = thresholds.includes(pct);
              return (
                <label
                  key={pct}
                  className="inline-flex cursor-pointer items-center gap-2 text-sm text-[var(--color-ink)]"
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => onToggleThreshold(pct)}
                    className="h-4 w-4 rounded border-[var(--color-hairline)]"
                  />
                  {pct}%
                </label>
              );
            })}
          </div>
          <p className="text-[11px] leading-snug text-[var(--color-ink-muted)]">
            Alerts are delivered to your main group via the IPC pattern (same
            channel open_dm cost-cap alerts use). v1 fires on test only;
            auto-trigger on real threshold breach lands in v1.5.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            onClick={onSave}
            disabled={saving || testing || !budgetValid}
          >
            {saving ? 'Saving…' : 'Save'}
          </Button>
          <Button
            type="button"
            variant="ghost"
            onClick={onTest}
            disabled={saving || testing || !budgetValid}
          >
            <Send className="h-3.5 w-3.5" aria-hidden="true" />
            {testing ? 'Sending…' : 'Send test alert'}
          </Button>
        </div>

        {saveMsg && (
          <p
            className={`text-xs ${
              saveMsg.kind === 'ok'
                ? 'text-emerald-700 dark:text-emerald-300'
                : 'text-red-700 dark:text-red-300'
            }`}
          >
            {saveMsg.text}
          </p>
        )}
        {testMsg && (
          <p
            className={`text-xs ${
              testMsg.kind === 'ok'
                ? 'text-emerald-700 dark:text-emerald-300'
                : 'text-red-700 dark:text-red-300'
            }`}
          >
            {testMsg.text}
          </p>
        )}
      </div>
    </Card>
  );
}

function readAlertsConfig(group: Group): AlertsConfig {
  const cfg = group.container_config as Record<string, unknown> | null;
  const raw = cfg?.['costAlerts'];
  if (raw && typeof raw === 'object' && raw !== null) {
    const obj = raw as Record<string, unknown>;
    const budget =
      typeof obj.dailyBudgetCents === 'number'
        ? obj.dailyBudgetCents
        : DEFAULT_BUDGET_CENTS;
    const thresholdsRaw = Array.isArray(obj.alertThresholds)
      ? obj.alertThresholds.filter(
          (v): v is number => typeof v === 'number',
        )
      : [50, 80, 100];
    return { dailyBudgetCents: budget, alertThresholds: thresholdsRaw };
  }
  return {
    dailyBudgetCents: DEFAULT_BUDGET_CENTS,
    alertThresholds: [50, 80, 100],
  };
}

function centsToDollarsInput(cents: number): string {
  return (cents / 100).toFixed(2);
}

function parseDollarsToCents(input: string): number | null {
  const n = Number(input);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}
