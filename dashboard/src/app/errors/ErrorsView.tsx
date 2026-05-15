'use client';

import { useCallback, useMemo, useState } from 'react';
import Link from 'next/link';
import { ChevronDown, ChevronRight, ExternalLink } from 'lucide-react';

import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ConnectionLossBanner } from '@/components/panels/ConnectionLossBanner';
import { usePoll } from '@/hooks/usePoll';
import { getTurns, type Turn } from '@/lib/nanoclaw';
import { diagnose, protocolOf } from '@/lib/error-diagnosis';
import { formatRelativeTime } from '@/lib/format';

const POLL_INTERVAL_MS = 10_000;
const DEFAULT_HOURS = 24;

/**
 * Errors page. Reads /api/turns?outcome=error, groups by error_class,
 * renders a diagnosis card per class with a list of affected groups
 * underneath. Each row is expandable to show the raw turn detail.
 *
 * Apple-philosophy heuristics applied:
 *   - Empty state teaches: "Nothing's gone wrong — yet" with the time
 *     window for context.
 *   - Status rendered, not counted: classes with transient errors
 *     (rate-limit, container.crash) get a muted "transient" pill so
 *     operators don't panic.
 *   - Names beat IDs: group name + agent name surface; folder/jid sit
 *     behind a tooltip.
 *   - Reversible by default: every diagnosis exposes a recovery
 *     affordance (link or intent).
 */
export function ErrorsView() {
  const [hours, setHours] = useState<number>(DEFAULT_HOURS);

  const since = useMemo(
    () => new Date(Date.now() - hours * 60 * 60 * 1000).toISOString(),
    [hours],
  );

  const fetcher = useCallback(
    () =>
      getTurns({
        outcome: 'error',
        since,
        limit: 500,
      }),
    [since],
  );

  const { data, error, loading } = usePoll<Turn[]>(fetcher, POLL_INTERVAL_MS);

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-3xl font-medium tracking-tight text-[var(--color-ink)]">
          Errors
        </h1>
        <p className="text-sm text-[var(--color-ink-muted)]">
          Turns where the agent failed to produce a reply. Grouped by
          cause; the recovery action sits next to each.
        </p>
      </header>

      <div className="flex items-center gap-2 text-xs text-[var(--color-ink-muted)]">
        <span>Window:</span>
        {[
          { label: '1h', h: 1 },
          { label: '24h', h: 24 },
          { label: '7d', h: 24 * 7 },
        ].map((opt) => (
          <button
            key={opt.h}
            onClick={() => setHours(opt.h)}
            className={`rounded-pill px-3 py-1 ${
              hours === opt.h
                ? 'bg-[var(--color-ink)] text-[var(--color-bg)]'
                : 'bg-[var(--color-bg-subtle)] hover:bg-[var(--color-hairline)]'
            }`}
            type="button"
          >
            {opt.label}
          </button>
        ))}
      </div>

      {error && <ConnectionLossBanner error={error} />}

      {loading && !data && (
        <p className="text-sm text-[var(--color-ink-muted)]">Loading errors…</p>
      )}

      {data && data.length === 0 && (
        <Card>
          <div className="space-y-2 p-6 text-center">
            <p className="text-base font-medium text-[var(--color-ink)]">
              Nothing’s gone wrong — yet.
            </p>
            <p className="text-sm text-[var(--color-ink-muted)]">
              No errored turns in the last {windowLabel(hours)}. When
              your agents hit auth, quota, or provider issues, they’ll
              land here with diagnosis copy and a recovery button.
            </p>
          </div>
        </Card>
      )}

      {data && data.length > 0 && (
        <ErrorGroupsByClass turns={data} />
      )}
    </div>
  );
}

function ErrorGroupsByClass({ turns }: { turns: Turn[] }) {
  // Group by error_class, then sort: persistent classes first (auth,
  // quota.over_budget, model.not_found), transient last.
  const byClass = useMemo(() => groupByClass(turns), [turns]);
  const sortedClasses = useMemo(() => {
    const persistent = new Set([
      'auth.invalid_key',
      'auth.expired_key',
      'quota.over_budget',
      'model.not_found',
    ]);
    return Array.from(byClass.keys()).sort((a, b) => {
      const aP = persistent.has(a) ? 0 : 1;
      const bP = persistent.has(b) ? 0 : 1;
      if (aP !== bP) return aP - bP;
      // Within each tier, sort by count descending.
      return (byClass.get(b)?.length ?? 0) - (byClass.get(a)?.length ?? 0);
    });
  }, [byClass]);

  return (
    <div className="space-y-4">
      {sortedClasses.map((cls) => (
        <ErrorClassCard
          key={cls}
          errorClass={cls}
          turns={byClass.get(cls) ?? []}
        />
      ))}
    </div>
  );
}

function ErrorClassCard({
  errorClass,
  turns,
}: {
  errorClass: string;
  turns: Turn[];
}) {
  const [expanded, setExpanded] = useState(false);
  // Take diagnosis context from the most recent turn — provider + model
  // can shift across turns if the operator switched mid-window.
  const latest = turns[0];
  const diagnosis = diagnose(errorClass, {
    provider: latest?.model ?? undefined,
    model: latest?.model ?? undefined,
  });

  return (
    <Card>
      <div className="space-y-3 p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-medium text-[var(--color-ink)]">
                {diagnosis.title}
              </h2>
              {diagnosis.transient && (
                <Badge>Transient</Badge>
              )}
              <span className="text-xs text-[var(--color-ink-muted)]">
                {turns.length} occurrence{turns.length === 1 ? '' : 's'}
              </span>
            </div>
            <p className="text-sm text-[var(--color-ink-muted)]">
              {diagnosis.description}
            </p>
            <p className="font-mono text-[10px] text-[var(--color-ink-dim)]">
              error_class: {errorClass}
            </p>
          </div>
          <div className="flex flex-shrink-0 flex-col items-end gap-2">
            {diagnosis.primary.href ? (
              <a
                href={diagnosis.primary.href}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 rounded-pill bg-[var(--color-ink)] px-3 py-1.5 text-xs font-medium text-[var(--color-bg)] hover:opacity-90"
              >
                {diagnosis.primary.label}
                <ExternalLink className="h-3 w-3" aria-hidden="true" />
              </a>
            ) : (
              <RecoveryButton action={diagnosis.primary} />
            )}
            {diagnosis.secondary && (
              diagnosis.secondary.href ? (
                <a
                  href={diagnosis.secondary.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]"
                >
                  {diagnosis.secondary.label}
                </a>
              ) : (
                <RecoveryButton action={diagnosis.secondary} />
              )
            )}
          </div>
        </div>

        <button
          onClick={() => setExpanded((v) => !v)}
          className="flex items-center gap-1 text-xs text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]"
          type="button"
        >
          {expanded ? (
            <ChevronDown className="h-3 w-3" aria-hidden="true" />
          ) : (
            <ChevronRight className="h-3 w-3" aria-hidden="true" />
          )}
          {expanded ? 'Hide' : 'Show'} affected turns
        </button>

        {expanded && (
          <div className="overflow-hidden rounded border border-[var(--color-hairline)]">
            <table className="w-full text-xs">
              <thead className="bg-[var(--color-bg-subtle)] text-[10px] font-semibold uppercase tracking-wider text-[var(--color-ink-muted)]">
                <tr>
                  <th className="px-2 py-1 text-left">When</th>
                  <th className="px-2 py-1 text-left">Group</th>
                  <th className="px-2 py-1 text-left">Model</th>
                  <th className="px-2 py-1 text-left">Duration</th>
                </tr>
              </thead>
              <tbody>
                {turns.slice(0, 25).map((t) => (
                  <tr
                    key={t.turn_id}
                    className="border-t border-[var(--color-hairline)]"
                  >
                    <td className="px-2 py-1 text-[var(--color-ink-muted)]">
                      {formatRelativeTime(t.started_at)}
                    </td>
                    <td className="px-2 py-1 text-[var(--color-ink)]">
                      <Link
                        href={`/groups/${encodeURIComponent(
                          t.group_jid ?? '',
                        )}`}
                        className="hover:underline"
                        title={t.group_folder}
                      >
                        {t.group_folder}
                      </Link>
                    </td>
                    <td className="px-2 py-1 font-mono text-[var(--color-ink-muted)]">
                      {protocolOf(t.model)}
                    </td>
                    <td className="px-2 py-1 text-[var(--color-ink-muted)]">
                      {t.duration_ms}ms
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {turns.length > 25 && (
              <p className="border-t border-[var(--color-hairline)] bg-[var(--color-bg-subtle)] px-2 py-1 text-[10px] text-[var(--color-ink-muted)]">
                … and {turns.length - 25} more. Use the Activity page for
                full pagination.
              </p>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}

function RecoveryButton({
  action,
}: {
  action: { label: string; variant: 'primary' | 'secondary'; intent?: string };
}) {
  // Intent-only actions (no href) are stubs for now — the underlying
  // recovery flows (switch model, raise budget, view logs) live on
  // pages PR 6 doesn't ship in full. Future PRs wire the intent
  // strings to dispatch into the relevant surface.
  return (
    <Button
      type="button"
      variant={action.variant === 'primary' ? 'primary' : 'ghost'}
      onClick={() => {
        if (typeof window !== 'undefined') {
          window.dispatchEvent(
            new CustomEvent('error-recovery-intent', {
              detail: { intent: action.intent },
            }),
          );
        }
      }}
    >
      {action.label}
    </Button>
  );
}

function groupByClass(turns: Turn[]): Map<string, Turn[]> {
  const out = new Map<string, Turn[]>();
  for (const t of turns) {
    const key = t.error_class ?? 'unknown';
    const arr = out.get(key);
    if (arr) arr.push(t);
    else out.set(key, [t]);
  }
  // Sort each bucket newest-first.
  for (const arr of out.values()) {
    arr.sort((a, b) => (a.started_at < b.started_at ? 1 : -1));
  }
  return out;
}

function windowLabel(hours: number): string {
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'}`;
  return `${hours / 24} day${hours === 24 ? '' : 's'}`;
}
