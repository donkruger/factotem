'use client';

import { Cpu } from 'lucide-react';

import { Badge } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import type { Health } from '@/lib/nanoclaw';
import { formatDurationMs } from '@/lib/format';

interface Props {
  onecli: Health['onecli'];
}

export function OneCLICard({ onecli }: Props) {
  const reachable = onecli.reachable;
  const latencyLabel =
    onecli.latency_ms === null
      ? '—'
      : formatDurationMs(onecli.latency_ms);
  const authMode = onecli.auth_mode ?? 'unknown';
  // Surface a soft warning if the auth mode is the OAuth workaround
  // (rotating subscription token; needs the launchd watcher healthy).
  const authVariant: 'success' | 'warning' | 'neutral' =
    authMode === 'api-key'
      ? 'success'
      : authMode === 'oauth-workaround'
        ? 'warning'
        : 'neutral';

  return (
    <Card>
      <div className="space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2">
            <Cpu
              className="h-5 w-5 text-[var(--color-accent)]"
              aria-hidden="true"
            />
            <h3 className="text-sm font-medium text-[var(--color-ink)]">
              OneCLI
            </h3>
          </div>
          <Badge variant={reachable ? 'success' : 'error'}>
            {reachable ? 'Reachable' : 'Unreachable'}
          </Badge>
        </div>

        <dl className="space-y-2 text-sm">
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-[var(--color-ink-muted)]">Latency</dt>
            <dd className="text-[var(--color-ink)]">{latencyLabel}</dd>
          </div>
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-[var(--color-ink-muted)]">Auth mode</dt>
            <dd>
              <Badge variant={authVariant}>{authMode}</Badge>
            </dd>
          </div>
        </dl>
      </div>
    </Card>
  );
}
