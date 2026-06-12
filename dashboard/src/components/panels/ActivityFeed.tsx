'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Download, MessageSquare } from 'lucide-react';

import { Card } from '@/components/ui/Card';
import { useAuthMode } from '@/hooks/useAuthMode';
import { usePoll } from '@/hooks/usePoll';
import {
  type CostDaily,
  type Group,
  type MessageHit,
  type Turn,
  getCostDaily,
  getGroups,
  getTurns,
  searchMessages,
  turnsCsvUrl,
} from '@/lib/nanoclaw';
import { formatRelativeTime } from '@/lib/format';

import { ActivityFilters, type FilterState, type Outcome, type TimeRange } from './ActivityFilters';
import { ActivityRow } from './ActivityRow';
import { ConnectionLossBanner } from './ConnectionLossBanner';
import { DailyRollupRail } from './DailyRollupRail';

const POLL_INTERVAL_MS = 3_000;

const DEFAULT_FILTERS: FilterState = {
  group: '',
  model: '',
  outcome: 'all',
  range: '24h',
  query: '',
};

function rangeToSince(range: TimeRange): string | undefined {
  const now = Date.now();
  if (range === '1h') return new Date(now - 60 * 60 * 1000).toISOString();
  if (range === '24h')
    return new Date(now - 24 * 60 * 60 * 1000).toISOString();
  if (range === '7d')
    return new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();
  return undefined; // 'all' = no filter
}

function readFiltersFromUrl(sp: URLSearchParams): FilterState {
  const range = sp.get('range');
  const outcome = sp.get('outcome');
  return {
    group: sp.get('group') ?? '',
    model: sp.get('model') ?? '',
    outcome:
      outcome === 'success' ||
      outcome === 'error' ||
      outcome === 'budget_capped'
        ? (outcome as Outcome)
        : 'all',
    range:
      range === '1h' || range === '24h' || range === '7d' || range === 'all'
        ? (range as TimeRange)
        : '24h',
    query: sp.get('q') ?? '',
  };
}

function writeFiltersToUrl(filters: FilterState): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.group) params.set('group', filters.group);
  if (filters.model) params.set('model', filters.model);
  if (filters.outcome !== 'all') params.set('outcome', filters.outcome);
  if (filters.range !== '24h') params.set('range', filters.range);
  if (filters.query) params.set('q', filters.query);
  return params;
}

/**
 * Activity panel: time-series feed of agent_turns rows, polled every 3s,
 * with filters (group / model / outcome / time range), per-row expand
 * for full SDK telemetry, a daily rollup rail, message-content search,
 * and CSV export.
 *
 * URL state is the single source of truth for filters so operators can
 * bookmark queries and share them.
 *
 * T-1778241000000 (Phase 3 of Factotem Dashboard v1 epic).
 */
export function ActivityFeed() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { usageMode } = useAuthMode();

  const [filters, setFilters] = useState<FilterState>(() =>
    readFiltersFromUrl(new URLSearchParams(searchParams.toString())),
  );
  const [selectedDay, setSelectedDay] = useState<string | null>(null);

  // Sync URL when filters change.
  useEffect(() => {
    const target = '/activity?' + writeFiltersToUrl(filters).toString();
    router.replace(target, { scroll: false });
  }, [filters, router]);

  // Turns query — drives the feed.
  const since = useMemo(() => {
    if (selectedDay) {
      return new Date(selectedDay + 'T00:00:00Z').toISOString();
    }
    return rangeToSince(filters.range);
  }, [filters.range, selectedDay]);

  const fetchTurns = useCallback(
    () =>
      getTurns({
        group: filters.group || undefined,
        model: filters.model || undefined,
        outcome: filters.outcome === 'all' ? undefined : filters.outcome,
        since,
        limit: 200,
      }),
    [filters.group, filters.model, filters.outcome, since],
  );
  const { data: turns, error, loading } = usePoll<Turn[]>(
    fetchTurns,
    POLL_INTERVAL_MS,
  );

  // Cost daily — drives the left rail.
  const fetchCostDaily = useCallback(() => getCostDaily({ days: 30 }), []);
  const { data: costRows } = usePoll<CostDaily[]>(fetchCostDaily, 30_000);

  // Groups list — populates the filter dropdown. Polled rarely.
  const fetchGroups = useCallback(() => getGroups(), []);
  const { data: groups } = usePoll<Group[]>(fetchGroups, 60_000);

  // Folder → friendly group-name lookup so each ActivityRow can render
  // "GGA" instead of "whatsapp_main". The raw folder is still surfaced
  // in the expanded Identity section for audit clarity.
  const folderToName = useMemo(() => {
    const map = new Map<string, string>();
    if (groups) for (const g of groups) if (g.folder && g.name) map.set(g.folder, g.name);
    return map;
  }, [groups]);

  // Models list — derived from the visible turns; falls back to a known
  // set so the dropdown isn't empty before the first turn lands.
  const models = useMemo(() => {
    const set = new Set<string>();
    if (turns) for (const t of turns) if (t.model) set.add(t.model);
    if (set.size === 0) {
      // Known v1 model set (per blueprint § Phase 0.2).
      set.add('claude-haiku-4-5-20251001');
      set.add('claude-sonnet-4-6');
      set.add('claude-opus-4-7');
    }
    return Array.from(set).sort();
  }, [turns]);

  // Message search — runs on demand, debounced.
  const [searchHits, setSearchHits] = useState<MessageHit[] | null>(null);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState<Error | null>(null);
  useEffect(() => {
    if (!filters.query || filters.query.trim().length < 2) {
      setSearchHits(null);
      setSearchError(null);
      return;
    }
    let cancelled = false;
    setSearchLoading(true);
    const handle = window.setTimeout(async () => {
      try {
        const hits = await searchMessages({ q: filters.query, limit: 20 });
        if (!cancelled) {
          setSearchHits(hits);
          setSearchError(null);
        }
      } catch (err) {
        if (!cancelled) setSearchError(err as Error);
      } finally {
        if (!cancelled) setSearchLoading(false);
      }
    }, 300);
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [filters.query]);

  const onChangeFilters = useCallback((next: Partial<FilterState>) => {
    setFilters((prev) => ({ ...prev, ...next }));
  }, []);
  const onClearFilters = useCallback(() => {
    setFilters(DEFAULT_FILTERS);
    setSelectedDay(null);
  }, []);

  const csvHref = turnsCsvUrl({
    group: filters.group || undefined,
    model: filters.model || undefined,
    outcome: filters.outcome === 'all' ? undefined : filters.outcome,
    since,
    limit: 5000,
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-medium tracking-tight text-[var(--color-ink)]">
            Activity
          </h1>
          <p className="mt-2 text-sm text-[var(--color-ink-muted)]">
            Per-turn telemetry from `agent_turns`. Polled every 3 seconds.
          </p>
        </div>
        <a
          href={csvHref}
          download
          className="inline-flex items-center gap-2 rounded-pill border border-[var(--color-hairline)] bg-[var(--color-bg)] px-4 py-2 text-sm text-[var(--color-ink)] transition-colors hover:bg-[var(--color-bg-subtle)]"
        >
          <Download className="h-4 w-4" aria-hidden="true" />
          Export CSV
        </a>
      </div>

      {error && <ConnectionLossBanner error={error} />}

      <ActivityFilters
        filters={filters}
        onChange={onChangeFilters}
        groups={groups ?? []}
        models={models}
        onClear={onClearFilters}
      />

      {filters.query && (
        <SearchResults
          query={filters.query}
          hits={searchHits}
          loading={searchLoading}
          error={searchError}
        />
      )}

      <div className="flex flex-col gap-6 lg:flex-row">
        <DailyRollupRail
          rows={costRows ?? []}
          selectedDay={selectedDay}
          onSelectDay={setSelectedDay}
          mode={usageMode ? 'usage' : 'cost'}
        />

        <div className="min-w-0 flex-1">
          {loading && !turns && (
            <Card>
              <p className="text-sm text-[var(--color-ink-muted)]">
                Loading agent turns…
              </p>
            </Card>
          )}

          {turns && turns.length === 0 && (
            <Card>
              <div className="space-y-2">
                <p className="text-sm text-[var(--color-ink)]">
                  No agent turns match the current filters.
                </p>
                <p className="text-xs text-[var(--color-ink-muted)]">
                  Telemetry capture started with the Wave 2 deploy. Existing
                  conversations before that deploy are not in this table; the
                  next agent reply on any group will land here within 5
                  seconds.
                </p>
              </div>
            </Card>
          )}

          {turns && turns.length > 0 && (
            <Card>
              <div className="-mx-6 -my-6">
                <div className="flex items-center justify-between border-b border-[var(--color-hairline)] px-4 py-2.5">
                  <p className="text-xs uppercase tracking-wider text-[var(--color-ink-muted)]">
                    {turns.length} turn{turns.length === 1 ? '' : 's'}
                  </p>
                </div>
                <div>
                  {turns.map((t) => (
                    <ActivityRow
                      key={t.turn_id}
                      turn={t}
                      groupName={folderToName.get(t.group_folder)}
                      mode={usageMode ? 'usage' : 'cost'}
                    />
                  ))}
                </div>
              </div>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

function SearchResults({
  query,
  hits,
  loading,
  error,
}: {
  query: string;
  hits: MessageHit[] | null;
  loading: boolean;
  error: Error | null;
}) {
  return (
    <Card>
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <MessageSquare
            className="h-4 w-4 text-[var(--color-ink-muted)]"
            aria-hidden="true"
          />
          <p className="text-xs uppercase tracking-wider text-[var(--color-ink-muted)]">
            Message search · &quot;{query}&quot;
          </p>
          {loading && (
            <span className="text-xs text-[var(--color-ink-muted)]">
              searching…
            </span>
          )}
        </div>
        {error && (
          <p className="text-xs text-red-700 dark:text-red-300">
            Search failed: {error.message}
          </p>
        )}
        {hits && hits.length === 0 && (
          <p className="text-xs text-[var(--color-ink-muted)]">
            No messages match &quot;{query}&quot;.
          </p>
        )}
        {hits && hits.length > 0 && (
          <ul className="space-y-2">
            {hits.map((m) => (
              <li
                key={m.id}
                className="rounded-xl border border-[var(--color-hairline)] bg-[var(--color-bg)] px-3 py-2 text-xs"
              >
                <div className="mb-1 flex items-center justify-between gap-2 text-[var(--color-ink-muted)]">
                  <span>
                    {m.sender_name || m.sender}
                    {m.is_from_me === 1 && ' (me)'}
                  </span>
                  <span>{formatRelativeTime(m.timestamp)}</span>
                </div>
                <p className="text-[var(--color-ink)]">{m.content}</p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}
