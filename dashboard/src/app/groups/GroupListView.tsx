'use client';

import { useCallback } from 'react';
import { useRouter } from 'next/navigation';

import { Card } from '@/components/ui/Card';
import { ConnectionLossBanner } from '@/components/panels/ConnectionLossBanner';
import { GroupListTable } from '@/components/panels/GroupListTable';
import { usePoll } from '@/hooks/usePoll';
import { type Group, getGroups, isGroupDeleted } from '@/lib/nanoclaw';

const POLL_INTERVAL_MS = 5_000;

/**
 * Client-only Group Management list view. Polls /api/groups every 5s,
 * shows the count + the WhatsApp /add-* skill hint, and renders the
 * filterable table. Row clicks navigate to the JID-scoped detail page.
 */
export function GroupListView() {
  const router = useRouter();
  const fetchGroups = useCallback(() => getGroups(), []);
  const { data, error, loading } = usePoll<Group[]>(fetchGroups, POLL_INTERVAL_MS);

  const groups = data ?? [];
  const visibleCount = groups.filter((g) => !isGroupDeleted(g)).length;

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <h1 className="text-3xl font-medium tracking-tight text-[var(--color-ink)]">
          Groups
        </h1>
        <p className="text-sm text-[var(--color-ink-muted)]">
          {data
            ? `${visibleCount} active group${visibleCount === 1 ? '' : 's'}.`
            : 'Loading groups…'}{' '}
          Add a group via the WhatsApp{' '}
          <code className="rounded bg-[var(--color-bg-subtle)] px-1.5 py-0.5 font-mono text-xs text-[var(--color-ink)]">
            /add-{'{name}'}
          </code>{' '}
          skill flow.
        </p>
      </div>

      {error && <ConnectionLossBanner error={error} />}

      {loading && !data && (
        <Card>
          <p className="text-sm text-[var(--color-ink-muted)]">
            Loading groups…
          </p>
        </Card>
      )}

      {data && (
        <GroupListTable
          groups={data}
          onSelect={(jid) =>
            router.push(`/groups/${encodeURIComponent(jid)}`)
          }
        />
      )}
    </div>
  );
}
