'use client';

import { Bot } from 'lucide-react';

import { Badge } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import type { Health } from '@/lib/nanoclaw';
import { formatDurationMs } from '@/lib/format';

interface Props {
  nanoclaw: Health['nanoclaw'];
}

export function NanoClawCard({ nanoclaw }: Props) {
  const running = nanoclaw.running === true;
  const versionLabel =
    nanoclaw.version === 'unknown' || !nanoclaw.version
      ? '—'
      : nanoclaw.version;

  return (
    <Card>
      <div className="space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2">
            <Bot
              className="h-5 w-5 text-[var(--color-accent)]"
              aria-hidden="true"
            />
            <h3 className="text-sm font-medium text-[var(--color-ink)]">
              NanoClaw
            </h3>
          </div>
          <Badge variant={running ? 'success' : 'error'}>
            {running ? 'Running' : 'Stopped'}
          </Badge>
        </div>

        <dl className="space-y-2 text-sm">
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-[var(--color-ink-muted)]">PID</dt>
            <dd className="font-mono text-[var(--color-ink)]">
              {nanoclaw.pid}
            </dd>
          </div>
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-[var(--color-ink-muted)]">Uptime</dt>
            <dd className="text-[var(--color-ink)]">
              {formatDurationMs(nanoclaw.uptime_seconds * 1000)}
            </dd>
          </div>
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-[var(--color-ink-muted)]">Version</dt>
            <dd className="font-mono text-xs text-[var(--color-ink)]">
              {versionLabel}
            </dd>
          </div>
        </dl>
      </div>
    </Card>
  );
}
