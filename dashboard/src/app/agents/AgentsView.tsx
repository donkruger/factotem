'use client';

import { useCallback } from 'react';
import Link from 'next/link';

import { Badge } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import { ConnectionLossBanner } from '@/components/panels/ConnectionLossBanner';
import { OrphanCredentialsBanner } from '@/components/panels/OrphanCredentialsBanner';
import { usePoll } from '@/hooks/usePoll';
import { getAgents, type Agent } from '@/lib/nanoclaw';

const POLL_INTERVAL_MS = 10_000;

/**
 * Agents-page client. Polls /api/agents every 10s. Renders one card per
 * agent with provider, default trigger, today's cost, and active-group
 * count.
 *
 * Apple-philosophy UX heuristics (PROVIDER_PLAYBOOK § 7.6):
 *   - One primary action per screen — there is none here yet; Add Agent
 *     lands in the next PR. The agents-list view is intentionally
 *     read-mostly so the primary CTA per card stays "View details" once
 *     the per-agent detail page ships.
 *   - Health rolls up: per-card cost dot uses a colour state, not a
 *     count of errors.
 *   - Empty state teaches: first-time operator with one agent still
 *     sees the page; "Add another agent" copy reminds them they can.
 */
export function AgentsView() {
  const fetchAgents = useCallback(() => getAgents(), []);
  const { data, error, loading } = usePoll<Agent[]>(
    fetchAgents,
    POLL_INTERVAL_MS,
  );

  return (
    <div className="space-y-6">
      {/* OrphanCredentialsBanner returns null when nothing's
       *  orphaned, so a healthy single-agent deployment sees
       *  zero new chrome. v1.2.1-finish-blueprint § 4. */}
      <OrphanCredentialsBanner />

      <header className="flex items-end justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-3xl font-medium tracking-tight text-[var(--color-ink)]">
            Agents
          </h1>
          <p className="text-sm text-[var(--color-ink-muted)]">
            Each agent is one named persona on one provider. Groups belong
            to agents; per-message <code>@name</code> mentions dispatch to
            the matching agent.
          </p>
        </div>
      </header>

      {error && <ConnectionLossBanner error={error} />}

      {loading && !data && (
        <p className="text-sm text-[var(--color-ink-muted)]">Loading agents…</p>
      )}

      {data && data.length === 0 && (
        <Card>
          <div className="p-6 text-sm text-[var(--color-ink-muted)]">
            No agents registered yet. Run the setup wizard to create your
            first one.
          </div>
        </Card>
      )}

      {data && data.length > 0 && (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {data.map((agent) => (
            <AgentCard key={agent.id} agent={agent} />
          ))}
        </div>
      )}

      {data && data.length === 1 && (
        <p className="text-xs text-[var(--color-ink-muted)]">
          Tip: re-launch the setup wizard to add a second agent on a
          different provider (Gemini, OpenAI, Ollama, …).
        </p>
      )}
    </div>
  );
}

function AgentCard({ agent }: { agent: Agent }) {
  const costToday = agent.cost_today_cents
    ? `$${(agent.cost_today_cents / 100).toFixed(2)}`
    : '$0.00';
  return (
    <Link
      href={`/agents/${encodeURIComponent(agent.id)}`}
      className="block transition-colors hover:bg-[var(--color-bg-subtle)] focus:outline-none focus:ring-2 focus:ring-[var(--color-ink)]"
      aria-label={`Open ${agent.name}'s detail page`}
    >
      <Card>
        <div className="space-y-3 p-5">
          <div className="flex items-start justify-between gap-2">
          <div className="space-y-0.5">
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-medium text-[var(--color-ink)]">
                {agent.name}
              </h2>
              {agent.is_default && <Badge>Default</Badge>}
            </div>
            <p className="font-mono text-xs text-[var(--color-ink-muted)]">
              {agent.default_trigger}
            </p>
          </div>
          <ProviderChip
            protocol={agent.provider.protocol}
            model={agent.provider.model}
          />
        </div>

        {agent.persona && (
          <p className="text-sm text-[var(--color-ink-muted)]">
            {agent.persona}
          </p>
        )}

        <dl className="grid grid-cols-2 gap-3 text-sm">
          <div>
            <dt className="text-[10px] font-semibold uppercase tracking-wider text-[var(--color-ink-muted)]">
              Active groups
            </dt>
            <dd className="text-[var(--color-ink)]">
              {agent.active_group_count ?? 0}
            </dd>
          </div>
          <div>
            <dt className="text-[10px] font-semibold uppercase tracking-wider text-[var(--color-ink-muted)]">
              Today
            </dt>
            <dd className="text-[var(--color-ink)]">{costToday}</dd>
          </div>
          </dl>
        </div>
      </Card>
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
