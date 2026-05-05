'use client';

import { useCallback } from 'react';

import { Badge } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import { Stat } from '@/components/ui/Stat';
import { usePoll } from '@/hooks/usePoll';
import { getHealth, type Health } from '@/lib/nanoclaw';
import { formatDurationMs } from '@/lib/format';

interface SubsystemStatus {
  label: string;
  state: 'ok' | 'warn' | 'error' | 'unknown';
  detail?: string;
}

function deriveStatuses(h: Health): SubsystemStatus[] {
  return [
    {
      label: 'NanoClaw',
      state: h.nanoclaw.running ? 'ok' : 'error',
      detail: h.nanoclaw.running
        ? `pid ${h.nanoclaw.pid} · v${h.nanoclaw.version}`
        : 'not running',
    },
    {
      label: 'Docker',
      state: h.docker.running ? 'ok' : 'error',
      detail: h.docker.running
        ? `${h.docker.containers_active} container(s) active`
        : 'engine unreachable',
    },
    {
      label: 'OneCLI',
      state: h.onecli.reachable ? 'ok' : 'error',
      detail: h.onecli.reachable
        ? `${formatDurationMs(h.onecli.latency_ms ?? 0)}${
            h.onecli.auth_mode ? ' · ' + h.onecli.auth_mode : ''
          }`
        : 'gateway unreachable',
    },
    {
      label: 'WhatsApp',
      state: h.whatsapp.authenticated ? 'ok' : 'warn',
      detail: h.whatsapp.authenticated
        ? 'authenticated'
        : 'not authenticated',
    },
    {
      label: 'Open DM',
      state: h.open_dm.enabled ? 'ok' : 'unknown',
      detail: h.open_dm.enabled
        ? `budget ${h.open_dm.daily_budget_cents ?? 0}¢ · spent ${h.open_dm.today_spent_cents}¢`
        : 'disabled',
    },
  ];
}

function badgeVariantFor(state: SubsystemStatus['state']) {
  if (state === 'ok') return 'success' as const;
  if (state === 'warn') return 'warning' as const;
  if (state === 'error') return 'error' as const;
  return 'neutral' as const;
}

export default function Page() {
  const fetchHealth = useCallback(() => getHealth(), []);
  const { data, error, loading } = usePoll<Health>(fetchHealth, 5000);

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-medium tracking-tight text-[var(--color-ink)]">
          Server Health
        </h1>
        <p className="mt-2 text-sm text-[var(--color-ink-muted)]">
          Wave 3 scaffold — full panel content lands in Wave 4 (T-1778240000000)
        </p>
      </div>

      {loading && !data && (
        <Card>
          <p className="text-sm text-[var(--color-ink-muted)]">
            Loading health snapshot…
          </p>
        </Card>
      )}

      {error && (
        <Card>
          <div className="space-y-2">
            <Badge variant="error">Error</Badge>
            <p className="text-sm text-[var(--color-ink)]">
              Failed to load health snapshot.
            </p>
            <p className="text-xs text-[var(--color-ink-muted)]">
              {error.message}
            </p>
          </div>
        </Card>
      )}

      {data && (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <Card>
              <Stat
                label="Process uptime"
                value={formatDurationMs(data.nanoclaw.uptime_seconds * 1000)}
                sublabel={`pid ${data.nanoclaw.pid}`}
              />
            </Card>
            <Card>
              <Stat
                label="Active containers"
                value={String(data.docker.containers_active)}
                sublabel={data.docker.image_tag ?? 'no image tag'}
              />
            </Card>
            <Card>
              <Stat
                label="Machine"
                value={data.machine.hostname || 'unknown'}
                sublabel={data.machine.platform}
              />
            </Card>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {deriveStatuses(data).map((s) => (
              <Card key={s.label}>
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p className="text-sm font-medium text-[var(--color-ink)]">
                      {s.label}
                    </p>
                    {s.detail && (
                      <p className="mt-1 text-xs text-[var(--color-ink-muted)]">
                        {s.detail}
                      </p>
                    )}
                  </div>
                  <Badge variant={badgeVariantFor(s.state)}>
                    {s.state.toUpperCase()}
                  </Badge>
                </div>
              </Card>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
