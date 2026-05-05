'use client';

import { useCallback, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';

import { Card } from '@/components/ui/Card';
import { ConnectionLossBanner } from '@/components/panels/ConnectionLossBanner';
import { ActivityRow } from '@/components/panels/ActivityRow';
import { GroupConfigEditor } from '@/components/panels/GroupConfigEditor';
import { GroupDetailHeader } from '@/components/panels/GroupDetailHeader';
import { usePoll } from '@/hooks/usePoll';
import {
  type Group,
  type Turn,
  getGroup,
  getTurns,
} from '@/lib/nanoclaw';
import { formatRelativeTime } from '@/lib/format';

interface GroupDetailViewProps {
  jid: string;
}

type TabKey = 'overview' | 'activity' | 'configuration';

const TABS: { key: TabKey; label: string }[] = [
  { key: 'overview', label: 'Overview' },
  { key: 'activity', label: 'Activity' },
  { key: 'configuration', label: 'Configuration' },
];

const GROUP_POLL_MS = 10_000;
const TURNS_POLL_MS = 10_000;

/**
 * Detail view for a single registered group. Client component because it
 * polls and owns tab UI state. Reuses the shared ActivityRow for the
 * embedded activity slice but skips the filter bar / rollup rail to
 * keep this surface focused.
 */
export function GroupDetailView({ jid }: GroupDetailViewProps) {
  const [tab, setTab] = useState<TabKey>('overview');
  const [refreshNonce, setRefreshNonce] = useState(0);

  // The placeholder slug from generateStaticParams. When the user lands
  // on this page directly without a real JID we surface a friendly hint
  // instead of dispatching a doomed fetch.
  const isPlaceholder = jid === '_' || jid === '';

  const fetchGroup = useCallback(
    () => getGroup(jid),
    // refreshNonce forces a re-poll after a successful mutation so the
    // editor rebases on the canonical state immediately.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [jid, refreshNonce],
  );
  const {
    data: group,
    error,
    loading,
  } = usePoll<Group>(fetchGroup, GROUP_POLL_MS);

  if (isPlaceholder) {
    return (
      <div className="space-y-6">
        <Link
          href="/groups"
          className="inline-flex items-center gap-1 text-sm text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" /> Back to groups
        </Link>
        <Card>
          <p className="text-sm text-[var(--color-ink-muted)]">
            Open a group from the list to see its detail view.
          </p>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <Link
        href="/groups"
        className="inline-flex items-center gap-1 text-sm text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden="true" /> Back to groups
      </Link>

      {error && <ConnectionLossBanner error={error} />}

      {loading && !group && (
        <Card>
          <p className="text-sm text-[var(--color-ink-muted)]">
            Loading group…
          </p>
        </Card>
      )}

      {group && (
        <>
          <GroupDetailHeader group={group} />

          <div className="flex items-center gap-1 border-b border-[var(--color-hairline)]">
            {TABS.map((t) => {
              const active = t.key === tab;
              return (
                <button
                  key={t.key}
                  type="button"
                  onClick={() => setTab(t.key)}
                  className={`-mb-px border-b-2 px-4 py-2 text-sm font-medium transition-colors ${
                    active
                      ? 'border-[var(--color-accent)] text-[var(--color-ink)]'
                      : 'border-transparent text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]'
                  }`}
                >
                  {t.label}
                </button>
              );
            })}
          </div>

          {tab === 'overview' && <OverviewTab group={group} />}
          {tab === 'activity' && <ActivityTab folder={group.folder} />}
          {tab === 'configuration' && (
            <GroupConfigEditor
              group={group}
              onSaved={() => setRefreshNonce((n) => n + 1)}
            />
          )}
        </>
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Tab bodies
// ──────────────────────────────────────────────────────────────────────────

function OverviewTab({ group }: { group: Group }) {
  // Pull the most recent turn for this group folder so we can surface a
  // real "last active" stat — /api/groups itself doesn't carry that
  // metric (per the API shape in lib/nanoclaw.ts).
  const fetchLatestTurn = useCallback(
    () => getTurns({ group: group.folder, limit: 1 }),
    [group.folder],
  );
  const { data: latestTurns } = usePoll<Turn[]>(fetchLatestTurn, 30_000);
  const latest = latestTurns && latestTurns.length > 0 ? latestTurns[0] : null;

  const cfg = group.container_config as Record<string, unknown> | null;
  const trigger = group.trigger ?? '—';

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Card>
        <div className="space-y-3">
          <p className="text-xs uppercase tracking-wider text-[var(--color-ink-muted)]">
            Activity summary
          </p>
          <dl className="space-y-2 text-sm">
            <Row
              label="Last turn"
              value={
                latest
                  ? formatRelativeTime(latest.started_at)
                  : 'No telemetry yet'
              }
            />
            <Row
              label="Last outcome"
              value={latest ? latest.outcome : '—'}
              mono={!latest}
            />
            <Row
              label="Last model"
              value={latest?.model ?? '—'}
              mono
            />
          </dl>
        </div>
      </Card>

      <Card>
        <div className="space-y-3">
          <p className="text-xs uppercase tracking-wider text-[var(--color-ink-muted)]">
            Routing
          </p>
          <dl className="space-y-2 text-sm">
            <Row label="Trigger" value={trigger} mono />
            <Row
              label="Requires trigger"
              value={group.requires_trigger ? 'yes' : 'no'}
            />
            <Row
              label="Profile"
              value={
                typeof cfg?.['agentProfile'] === 'string'
                  ? (cfg['agentProfile'] as string)
                  : 'main'
              }
              mono
            />
          </dl>
        </div>
      </Card>
    </div>
  );
}

function ActivityTab({ folder }: { folder: string }) {
  const fetchTurns = useCallback(
    () => getTurns({ group: folder, limit: 20 }),
    [folder],
  );
  const { data: turns, error, loading } = usePoll<Turn[]>(
    fetchTurns,
    TURNS_POLL_MS,
  );

  if (error) {
    return (
      <Card>
        <p className="text-sm text-red-700 dark:text-red-300">
          Failed to load activity: {error.message}
        </p>
      </Card>
    );
  }

  if (loading && !turns) {
    return (
      <Card>
        <p className="text-sm text-[var(--color-ink-muted)]">
          Loading activity…
        </p>
      </Card>
    );
  }

  if (turns && turns.length === 0) {
    return (
      <Card>
        <p className="text-sm text-[var(--color-ink-muted)]">
          No telemetry yet for this group. Turns will land here within a few
          seconds of the next agent reply.
        </p>
      </Card>
    );
  }

  return (
    <Card>
      <div className="-mx-6 -my-6">
        <div className="border-b border-[var(--color-hairline)] px-4 py-2.5">
          <p className="text-xs uppercase tracking-wider text-[var(--color-ink-muted)]">
            {turns?.length ?? 0} recent turn
            {turns?.length === 1 ? '' : 's'}
          </p>
        </div>
        <div>
          {(turns ?? []).map((t) => (
            <ActivityRow key={t.turn_id} turn={t} />
          ))}
        </div>
      </div>
    </Card>
  );
}

function Row({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-[var(--color-ink-muted)]">{label}</dt>
      <dd
        className={`text-right text-[var(--color-ink)] ${mono ? 'font-mono text-xs' : ''}`}
      >
        {value}
      </dd>
    </div>
  );
}
