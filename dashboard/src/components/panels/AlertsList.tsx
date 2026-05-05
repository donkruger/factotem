'use client';

import { useCallback, useMemo, useState } from 'react';
import { CheckCircle } from 'lucide-react';

import { Card } from '@/components/ui/Card';
import { usePoll } from '@/hooks/usePoll';
import { formatRelativeTime } from '@/lib/format';
import {
  type Alert,
  type AlertSeverity,
  type AlertsResponse,
  getAlerts,
} from '@/lib/nanoclaw';

import { AlertCard } from './AlertCard';
import { ConnectionLossBanner } from './ConnectionLossBanner';

const POLL_INTERVAL_MS = 10_000;

const SEVERITY_RANK: Record<AlertSeverity, number> = {
  critical: 0,
  warning: 1,
  info: 2,
};

/**
 * Top-level Alerts panel. Polls /api/alerts every 10 seconds and renders
 * each detected failure mode as an AlertCard. After the operator runs
 * Restart Stack we bump a refresh nonce so the next poll fires
 * immediately rather than waiting for the regular tick.
 */
export function AlertsList() {
  const [refreshNonce, setRefreshNonce] = useState(0);

  // The lint rule wants getAlerts() in the dependency array, but our
  // intent is to re-fire on refreshNonce changes. usePoll memoises by
  // identity so the nonce in the closure ensures a fresh fetch.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const fetchAlerts = useCallback(() => getAlerts(), [refreshNonce]);

  const { data, error } = usePoll<AlertsResponse>(fetchAlerts, POLL_INTERVAL_MS);

  const bumpRefresh = useCallback(() => {
    setRefreshNonce((n) => n + 1);
  }, []);

  const sortedAlerts = useMemo<Alert[]>(() => {
    if (!data) return [];
    return [...data.alerts].sort(
      (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity],
    );
  }, [data]);

  const restartStackEnabled = data?.restart_stack_enabled ?? false;
  const detectedAt = data?.detected_at ?? null;
  const total = sortedAlerts.length;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-medium tracking-tight text-[var(--color-ink)]">
            Alerts
          </h1>
          <p className="mt-2 text-sm text-[var(--color-ink-muted)]">
            Detected failure modes from the Round 7 catalogue. Polled every
            10 seconds.
          </p>
        </div>
        <div className="text-right text-xs text-[var(--color-ink-muted)]">
          <div>
            {total === 0 ? 'No active alerts' : `${total} active`}
            {detectedAt && (
              <>
                {' '}
                <span aria-hidden="true">·</span> checked{' '}
                <time dateTime={detectedAt}>
                  {formatRelativeTime(detectedAt)}
                </time>
              </>
            )}
          </div>
        </div>
      </div>

      {error && <ConnectionLossBanner error={error} />}

      {!error && total === 0 && (
        <Card>
          <div className="flex items-start gap-3">
            <CheckCircle
              className="mt-0.5 h-5 w-5 flex-shrink-0 text-emerald-600 dark:text-emerald-400"
              aria-hidden="true"
            />
            <div className="flex-1 space-y-2">
              <div className="flex items-center gap-2">
                <h2 className="text-base font-medium text-[var(--color-ink)]">
                  No active alerts
                </h2>
                <span aria-hidden="true">🟢</span>
              </div>
              <p className="text-sm text-[var(--color-ink-muted)]">
                Alerts auto-detect from these signals: Docker engine, OneCLI
                gateway, oauth-refresh watcher freshness, ghost-action
                heuristic, and WhatsApp reconnect frequency.
              </p>
            </div>
          </div>
        </Card>
      )}

      {!error && total > 0 && (
        <div className="space-y-3">
          {sortedAlerts.map((alert) => (
            <AlertCard
              key={alert.id}
              alert={alert}
              restartStackEnabled={restartStackEnabled}
              onRestartCompleted={bumpRefresh}
            />
          ))}
        </div>
      )}
    </div>
  );
}
