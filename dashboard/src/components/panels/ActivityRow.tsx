'use client';

import { useState } from 'react';
import { ChevronDown, ChevronRight, ExternalLink } from 'lucide-react';

import { Badge } from '@/components/ui/Badge';
import type { Turn } from '@/lib/nanoclaw';
import {
  formatCostCents,
  formatDurationMs,
  formatRelativeTime,
} from '@/lib/format';

interface Props {
  turn: Turn;
}

function shortenModel(m: string | null | undefined): string {
  if (!m) return '—';
  return m.replace(/^claude-/, '').replace(/-\d{8}$/, '');
}

function outcomeVariant(o: Turn['outcome']) {
  if (o === 'success') return 'success' as const;
  if (o === 'budget_capped') return 'warning' as const;
  return 'error' as const;
}

/**
 * Single row in the Activity feed. Compact summary collapses to a row;
 * expanding reveals the full SDK telemetry — token breakdown, latency,
 * tool counts, retries, compaction. The "step timeline with nested
 * retries" pattern from R9 is approximated here as a stat block; a true
 * per-tool-call timeline requires per-message capture (R8 follow-up).
 */
export function ActivityRow({ turn }: Props) {
  const [open, setOpen] = useState(false);

  const totalTokens =
    (turn.input_tokens ?? 0) + (turn.output_tokens ?? 0);
  const tokensLabel =
    turn.input_tokens === null || turn.input_tokens === undefined
      ? '—'
      : `${(turn.input_tokens ?? 0).toLocaleString()}/${(
          turn.output_tokens ?? 0
        ).toLocaleString()}`;

  return (
    <div className="border-b border-[var(--color-hairline)] last:border-b-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-4 px-4 py-3 text-left transition-colors hover:bg-[var(--color-bg-subtle)]"
      >
        <span className="flex-shrink-0 text-[var(--color-ink-muted)]">
          {open ? (
            <ChevronDown className="h-4 w-4" aria-hidden="true" />
          ) : (
            <ChevronRight className="h-4 w-4" aria-hidden="true" />
          )}
        </span>
        <span className="w-28 flex-shrink-0 text-xs text-[var(--color-ink-muted)]">
          {formatRelativeTime(turn.started_at)}
        </span>
        <span className="w-40 flex-shrink-0 truncate text-sm text-[var(--color-ink)]">
          {turn.group_folder}
        </span>
        <span className="w-24 flex-shrink-0 text-xs font-mono text-[var(--color-ink-muted)]">
          {shortenModel(turn.model)}
        </span>
        <span className="w-32 flex-shrink-0 text-xs text-[var(--color-ink-muted)]">
          {tokensLabel}
        </span>
        <span className="w-16 flex-shrink-0 text-right text-xs text-[var(--color-ink)]">
          {formatCostCents(turn.est_cost_cents ?? 0)}
        </span>
        <span className="w-20 flex-shrink-0 text-right text-xs text-[var(--color-ink-muted)]">
          {formatDurationMs(turn.duration_ms ?? 0)}
        </span>
        <span className="ml-auto flex-shrink-0">
          <Badge variant={outcomeVariant(turn.outcome)}>{turn.outcome}</Badge>
        </span>
      </button>

      {open && (
        <div className="border-t border-[var(--color-hairline)] bg-[var(--color-bg-subtle)] px-4 py-4">
          <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-4">
            <DetailGroup title="Tokens">
              <Detail label="Input" value={(turn.input_tokens ?? 0).toLocaleString()} />
              <Detail label="Output" value={(turn.output_tokens ?? 0).toLocaleString()} />
              <Detail
                label="Cache create"
                value={(turn.cache_creation_input_tokens ?? 0).toLocaleString()}
              />
              <Detail
                label="Cache read"
                value={(turn.cache_read_input_tokens ?? 0).toLocaleString()}
              />
              <Detail
                label="Total"
                value={totalTokens.toLocaleString()}
                accent
              />
            </DetailGroup>

            <DetailGroup title="Timing">
              <Detail label="Started" value={turn.started_at} mono />
              <Detail label="Finished" value={turn.finished_at || '—'} mono />
              <Detail
                label="Duration"
                value={formatDurationMs(turn.duration_ms ?? 0)}
              />
              <Detail
                label="API duration"
                value={
                  turn.duration_api_ms
                    ? formatDurationMs(turn.duration_api_ms)
                    : '—'
                }
              />
              <Detail
                label="TTFT"
                value={turn.ttft_ms ? formatDurationMs(turn.ttft_ms) : '—'}
              />
            </DetailGroup>

            <DetailGroup title="Reliability">
              <Detail label="Tool calls" value={String(turn.tool_use_count ?? 0)} />
              <Detail
                label="Tool errors"
                value={String(turn.tool_error_count ?? 0)}
                accent={(turn.tool_error_count ?? 0) > 0}
              />
              <Detail
                label="Retries"
                value={String(turn.retry_count ?? 0)}
                accent={(turn.retry_count ?? 0) > 0}
              />
              <Detail
                label="Compactions"
                value={String(turn.compaction_count ?? 0)}
              />
              <Detail label="SDK turns" value={String(turn.num_turns ?? '—')} />
            </DetailGroup>

            <DetailGroup title="Identity">
              <Detail label="turn_id" value={turn.turn_id} mono small />
              <Detail
                label="session_id"
                value={turn.session_id || '—'}
                mono
                small
              />
              <Detail
                label="agent_profile"
                value={turn.agent_profile || 'main'}
                mono
              />
              <Detail
                label="machine_id"
                value={turn.machine_id.slice(0, 8) + '…'}
                mono
                small
              />
              {turn.error_class && (
                <Detail
                  label="error_class"
                  value={turn.error_class}
                  mono
                  accent
                />
              )}
            </DetailGroup>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-4 border-t border-[var(--color-hairline)] pt-3 text-xs text-[var(--color-ink-muted)]">
            <span>
              Prompt:{' '}
              <span className="text-[var(--color-ink)]">
                {(turn.prompt_chars ?? 0).toLocaleString()} chars
              </span>
            </span>
            <span>
              Response:{' '}
              <span className="text-[var(--color-ink)]">
                {(turn.response_chars ?? 0).toLocaleString()} chars
              </span>
            </span>
            {turn.attachment_count !== undefined &&
              turn.attachment_count > 0 && (
                <span>
                  Attachments:{' '}
                  <span className="text-[var(--color-ink)]">
                    {turn.attachment_count}
                  </span>
                </span>
              )}
            <span className="ml-auto opacity-60">
              <ExternalLink
                className="mr-1 inline h-3 w-3"
                aria-hidden="true"
              />
              Raw container log: not yet plumbed (v1.5)
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

function DetailGroup({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <p className="mb-2 text-xs uppercase tracking-wider text-[var(--color-ink-muted)]">
        {title}
      </p>
      <dl className="space-y-1.5">{children}</dl>
    </div>
  );
}

function Detail({
  label,
  value,
  mono = false,
  small = false,
  accent = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
  small?: boolean;
  accent?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-2 text-xs">
      <dt className="flex-shrink-0 text-[var(--color-ink-muted)]">{label}</dt>
      <dd
        className={`text-right ${mono ? 'font-mono' : ''} ${
          small ? 'text-[10px]' : ''
        } ${
          accent ? 'text-[var(--color-accent)]' : 'text-[var(--color-ink)]'
        }`}
      >
        {value}
      </dd>
    </div>
  );
}
