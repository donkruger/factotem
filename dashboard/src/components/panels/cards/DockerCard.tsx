'use client';

import { Box } from 'lucide-react';

import { Badge } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import type { Health } from '@/lib/nanoclaw';

interface Props {
  docker: Health['docker'];
}

export function DockerCard({ docker }: Props) {
  return (
    <Card>
      <div className="space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2">
            <Box
              className="h-5 w-5 text-[var(--color-accent)]"
              aria-hidden="true"
            />
            <h3 className="text-sm font-medium text-[var(--color-ink)]">
              Docker
            </h3>
          </div>
          <Badge variant={docker.running ? 'success' : 'error'}>
            {docker.running ? 'Reachable' : 'Unreachable'}
          </Badge>
        </div>

        <dl className="space-y-2 text-sm">
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-[var(--color-ink-muted)]">
              Active containers
            </dt>
            <dd className="text-[var(--color-ink)]">
              {docker.containers_active}
            </dd>
          </div>
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-[var(--color-ink-muted)]">Image tag</dt>
            <dd className="font-mono text-xs text-[var(--color-ink)]">
              {docker.image_tag ?? (
                <span className="text-[var(--color-ink-muted)]">—</span>
              )}
            </dd>
          </div>
        </dl>
      </div>
    </Card>
  );
}
