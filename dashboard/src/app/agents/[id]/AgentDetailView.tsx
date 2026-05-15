'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';

import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
} from '@/components/ui/Table';
import { ConnectionLossBanner } from '@/components/panels/ConnectionLossBanner';
import { ModelSwitchModal } from '@/components/panels/ModelSwitchModal';
import { AgentPairingAndBudget } from '@/components/panels/AgentPairingAndBudget';
import { usePoll } from '@/hooks/usePoll';
import { type AgentDetail, getAgent, getTurns, type Turn } from '@/lib/nanoclaw';
import { diagnose } from '@/lib/error-diagnosis';
import { formatRelativeTime } from '@/lib/format';

const POLL_INTERVAL_MS = 10_000;

/**
 * Per-agent detail. Polls /api/agents/:id every 10s. Renders:
 *
 *   - Header with name, default-badge, provider chip, "Switch model" CTA
 *   - Persona block
 *   - Owned-groups list
 *   - Post-switch banner (when an audit-log entry within 5min is
 *     present — operator just switched and the next inbound message
 *     should validate the new container spawns cleanly)
 *
 * Apple-philosophy heuristics: health rolls up (per-agent dot inside the
 * header), names beat IDs (the agent's slug is in a muted tooltip),
 * single primary action ("Switch model"), reversible-by-default
 * (audit-undo within 5 min restores the prior provider).
 */
export function AgentDetailView() {
  const [id, setId] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [postSwitchBanner, setPostSwitchBanner] = useState<{
    fromModel: string;
    toModel: string;
  } | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const m = window.location.pathname.match(/^\/agents\/([^/]+)\/?$/);
    if (m && m[1]) setId(decodeURIComponent(m[1]));
    else setId('_');
  }, []);

  const isPlaceholder = id === '_' || id === '';
  const fetcher = useCallback(() => {
    if (id === null || isPlaceholder) {
      // Pre-hydration: don't fire a request against the placeholder.
      return new Promise<AgentDetail>(() => {});
    }
    return getAgent(id);
  }, [id, isPlaceholder]);

  const { data, error, loading } = usePoll<AgentDetail>(
    fetcher,
    POLL_INTERVAL_MS,
  );

  if (isPlaceholder) {
    return (
      <p className="text-sm text-[var(--color-ink-muted)]">Loading…</p>
    );
  }

  if (error && !data) {
    return (
      <div className="space-y-4">
        <BackLink />
        <ConnectionLossBanner error={error} />
      </div>
    );
  }

  if (loading && !data) {
    return <p className="text-sm text-[var(--color-ink-muted)]">Loading agent…</p>;
  }

  if (!data) return null;

  return (
    <div className="space-y-6">
      <BackLink />

      <header className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <h1 className="text-3xl font-medium tracking-tight text-[var(--color-ink)]">
              {data.name}
            </h1>
            {data.is_default && <Badge>Default</Badge>}
          </div>
          <div className="flex items-center gap-3 text-sm text-[var(--color-ink-muted)]">
            <span className="font-mono text-xs">{data.default_trigger}</span>
            <span>·</span>
            <ProviderChip
              protocol={data.provider.protocol}
              model={data.provider.model}
            />
          </div>
          <p
            className="text-xs text-[var(--color-ink-dim)]"
            title={`Agent id: ${data.id}`}
          >
            Memory: <code>{data.memory_namespace}</code>
          </p>
        </div>
        <Button variant="primary" onClick={() => setModalOpen(true)}>
          Switch model
        </Button>
      </header>

      {postSwitchBanner && (
        <Card>
          <div className="space-y-1 border-l-4 border-[var(--color-accent)] bg-[var(--color-bg-subtle)] p-4">
            <p className="text-sm text-[var(--color-ink)]">
              {data.name} is now on{' '}
              <strong>{postSwitchBanner.toModel}</strong>.
            </p>
            <p className="text-xs text-[var(--color-ink-muted)]">
              Send a message to one of {data.name}'s groups to verify.
              Within 5 minutes you can roll back to{' '}
              <strong>{postSwitchBanner.fromModel}</strong> from the Audit log.
            </p>
          </div>
        </Card>
      )}

      {data.persona && (
        <Card>
          <div className="space-y-2 p-5">
            <h2 className="text-[10px] font-semibold uppercase tracking-wider text-[var(--color-ink-muted)]">
              Persona
            </h2>
            <p className="whitespace-pre-wrap text-sm text-[var(--color-ink)]">
              {data.persona}
            </p>
          </div>
        </Card>
      )}

      <Card>
        <div className="space-y-3 p-5">
          <h2 className="text-[10px] font-semibold uppercase tracking-wider text-[var(--color-ink-muted)]">
            Groups using this agent
          </h2>
          {data.groups.length === 0 ? (
            <p className="text-sm text-[var(--color-ink-muted)]">
              No groups assigned yet.
            </p>
          ) : (
            <Table>
              <TableHead>
                <TableRow>
                  <TableCell header>Name</TableCell>
                  <TableCell header>Folder</TableCell>
                  <TableCell header>Trigger</TableCell>
                  <TableCell header>Main</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {data.groups.map((g) => (
                  <TableRow key={g.jid}>
                    <TableCell>
                      <Link
                        href={`/groups/${encodeURIComponent(g.jid)}`}
                        className="text-[var(--color-ink)] hover:underline"
                      >
                        {g.name}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <span className="font-mono text-xs text-[var(--color-ink-muted)]">
                        {g.folder}
                      </span>
                    </TableCell>
                    <TableCell>
                      <span className="font-mono text-xs text-[var(--color-ink-muted)]">
                        {g.trigger ?? '—'}
                      </span>
                    </TableCell>
                    <TableCell>{g.is_main ? <Badge>Main</Badge> : '—'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>
      </Card>

      <AgentPairingAndBudget agent={data} onChange={() => { /* refetch on next poll */ }} />

      <AgentRecentErrors agent={data} />

      <ModelSwitchModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        agent={data}
        onSwitched={(committed) => {
          setModalOpen(false);
          setPostSwitchBanner({
            fromModel: `${data.provider.protocol}/${data.provider.model}`,
            toModel: `${committed.protocol}/${committed.model}`,
          });
        }}
      />
    </div>
  );
}

/**
 * Recent errors for this agent. Polls /api/turns?outcome=error filtered
 * by the agent's groups (we filter client-side since /api/turns doesn't
 * yet accept an `agent` parameter — landing in a future endpoint
 * extension). Shows up to five most-recent errored turns; each row
 * carries the diagnosis title + a link to the full Errors page.
 */
function AgentRecentErrors({ agent }: { agent: AgentDetail }) {
  const fetcher = useCallback(
    () =>
      getTurns({
        outcome: 'error',
        since: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
        limit: 100,
      }),
    [],
  );
  const { data } = usePoll<Turn[]>(fetcher, 15_000);
  // Filter to this agent's groups by folder, since the agent_id isn't on
  // agent_turns rows in v1 (the column lands in PR 7 as part of the
  // attribution tightening).
  const ownedFolders = new Set(agent.groups.map((g) => g.folder));
  const ours = (data ?? []).filter((t) => ownedFolders.has(t.group_folder));
  if (ours.length === 0) return null;

  const top = ours.slice(0, 5);
  return (
    <Card>
      <div className="space-y-3 p-5">
        <div className="flex items-center justify-between">
          <h2 className="text-[10px] font-semibold uppercase tracking-wider text-[var(--color-ink-muted)]">
            Recent errors (24h)
          </h2>
          <Link
            href="/errors"
            className="text-xs text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]"
          >
            View all →
          </Link>
        </div>
        <ul className="space-y-1.5">
          {top.map((t) => {
            const d = diagnose(t.error_class, {
              provider: t.model,
              model: t.model,
              groupName: t.group_folder,
            });
            return (
              <li
                key={t.turn_id}
                className="flex items-start justify-between gap-3 border-l-2 border-[var(--color-warning)] bg-[var(--color-bg-subtle)] px-3 py-2 text-sm"
              >
                <div className="min-w-0 flex-1">
                  <p
                    className="font-medium text-[var(--color-ink)]"
                    title={t.error_class ?? 'unknown'}
                  >
                    {d.title}
                  </p>
                  <p className="text-xs text-[var(--color-ink-muted)]">
                    {t.group_folder} · {formatRelativeTime(t.started_at)}
                  </p>
                </div>
                {d.transient && <Badge>Transient</Badge>}
              </li>
            );
          })}
        </ul>
        {ours.length > top.length && (
          <p className="text-[11px] text-[var(--color-ink-muted)]">
            {ours.length - top.length} more in the last 24h. {' '}
            <Link
              href="/errors"
              className="underline hover:text-[var(--color-ink)]"
            >
              See full list →
            </Link>
          </p>
        )}
      </div>
    </Card>
  );
}

function BackLink() {
  return (
    <Link
      href="/agents"
      className="inline-flex items-center gap-1 text-sm text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]"
    >
      <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
      Back to Agents
    </Link>
  );
}

function ProviderChip({
  protocol,
  model,
}: {
  protocol: string;
  model: string;
}) {
  return (
    <span
      className="inline-flex items-center gap-1 rounded-pill bg-[var(--color-bg-subtle)] px-2 py-0.5 text-[11px] font-medium text-[var(--color-ink)]"
      title={`${protocol}/${model}`}
    >
      <span className="font-mono">{protocol}</span>
      <span className="text-[var(--color-ink-muted)]">/</span>
      <span className="font-mono text-[var(--color-ink-muted)]">{model}</span>
    </span>
  );
}
