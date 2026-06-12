'use client';

import { useState } from 'react';
import { ChevronDown, ChevronRight, ExternalLink } from 'lucide-react';

import { Badge } from '@/components/ui/Badge';
import type { Turn } from '@/lib/nanoclaw';
import {
  formatCostCents,
  formatDurationMs,
  formatRelativeTime,
  formatTokens,
} from '@/lib/format';

interface Props {
  turn: Turn;
  /**
   * Optional human-friendly group name (e.g. "GGA"). Falls back to
   * `turn.group_folder` when not supplied. The folder is always shown
   * in the expanded Identity section.
   */
  groupName?: string;
  /**
   * 'cost' (default) shows the per-turn dollar estimate in the summary row;
   * 'usage' shows total tokens instead — subscription/oauth deployments
   * where the dollar estimate is always $0.00.
   */
  mode?: 'cost' | 'usage';
}

function shortenModel(m: string | null | undefined): string {
  if (!m) return '—';
  return m.replace(/^claude-/, '').replace(/-\d{8}$/, '');
}

/**
 * Tooltips for the per-turn metric labels. Keep these short — they appear
 * as native browser tooltips on hover via the `title` attribute.
 */
const TIPS = {
  // Tokens
  Input: 'Tokens in your prompt — text the agent received before generating a reply.',
  Output: "Tokens produced in the agent's reply.",
  'Cache create':
    "Tokens stored in Anthropic's prompt cache. Charged at 1.25× input rate; saves cost on subsequent requests that reuse them.",
  'Cache read':
    'Tokens read from prompt cache. Charged at 0.1× input rate (90% discount).',
  Total: 'Sum of input + output tokens. Cache tokens are billed separately.',
  // Timing
  Started: 'Container spawn moment (ISO 8601 UTC).',
  Finished: 'Container completion moment.',
  Duration: 'Wall-clock time from container spawn to completion.',
  'API duration': 'Time spent in Anthropic API calls within the turn.',
  TTFT: 'Time to first token — latency before the first response chunk arrived.',
  // Reliability
  'Tool calls':
    'Number of MCP tool invocations the agent made (file ops, web fetch, KP writes, etc.).',
  'Tool errors':
    'Tool calls that returned an error. Non-zero values warrant a closer look at the expanded prompt/response.',
  Retries:
    'API-level retry attempts after transient errors (429s, 5xx). 0 in the happy path.',
  Compactions:
    'SDK conversation-compaction events — usually triggered when the context limit approaches.',
  'SDK turns':
    'Internal SDK conversation turn count (used by the compaction tracker).',
  // Identity
  turn_id: 'Globally unique identifier for this agent invocation.',
  session_id:
    'Conversation session — multiple turns can share a session for context continuity.',
  agent_profile:
    'Permission/mount profile that ran this turn (main, open_dm, etc.).',
  machine_id:
    'Identity of the NanoClaw deployment that executed this turn (federation-friendly).',
  group_folder:
    'Per-group folder name in the orchestrator. Always lowercase; used for filesystem paths and IPC routing.',
  group_jid: 'WhatsApp JID this turn was associated with.',
  error_class:
    'Error category if the turn failed. Open the matching log line in nanoclaw.log for the underlying message.',
  Prompt: 'Total characters in the prompt the agent received (input length proxy).',
  Response: 'Total characters in the agent reply (output length proxy).',
} as const;
type TipKey = keyof typeof TIPS;

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
export function ActivityRow({ turn, groupName, mode = 'cost' }: Props) {
  const [open, setOpen] = useState(false);

  const totalTokens =
    (turn.input_tokens ?? 0) + (turn.output_tokens ?? 0);
  const tokensLabel =
    turn.input_tokens === null || turn.input_tokens === undefined
      ? '—'
      : `${(turn.input_tokens ?? 0).toLocaleString()}/${(
          turn.output_tokens ?? 0
        ).toLocaleString()}`;
  const displayGroup = groupName ?? turn.group_folder;

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
        <span
          className="w-40 flex-shrink-0 truncate text-sm text-[var(--color-ink)]"
          title={`group_folder: ${turn.group_folder}`}
        >
          {displayGroup}
        </span>
        <span className="w-24 flex-shrink-0 text-xs font-mono text-[var(--color-ink-muted)]">
          {shortenModel(turn.model)}
        </span>
        <span className="w-32 flex-shrink-0 text-xs text-[var(--color-ink-muted)]">
          {tokensLabel}
        </span>
        <span
          className="w-16 flex-shrink-0 text-right text-xs text-[var(--color-ink)]"
          title={mode === 'usage' ? 'Total tokens (input + output)' : undefined}
        >
          {mode === 'usage'
            ? formatTokens(totalTokens)
            : formatCostCents(turn.est_cost_cents ?? 0)}
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
              <Detail
                label="Queue wait"
                value={
                  turn.queue_wait_ms != null
                    ? formatDurationMs(turn.queue_wait_ms)
                    : '—'
                }
                accent={(turn.queue_wait_ms ?? 0) > 1_000}
              />
              <Detail
                label="Concurrent at spawn"
                value={
                  turn.concurrent_at_spawn != null
                    ? String(turn.concurrent_at_spawn)
                    : '—'
                }
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
              <Detail
                label="group_folder"
                value={turn.group_folder}
                mono
                small
              />
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
            <span title={TIPS.Prompt} className="cursor-help underline decoration-dotted underline-offset-2">
              Prompt:{' '}
              <span className="text-[var(--color-ink)] no-underline">
                {(turn.prompt_chars ?? 0).toLocaleString()} chars
              </span>
            </span>
            <span title={TIPS.Response} className="cursor-help underline decoration-dotted underline-offset-2">
              Response:{' '}
              <span className="text-[var(--color-ink)] no-underline">
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
  tooltip,
}: {
  label: string;
  value: string;
  mono?: boolean;
  small?: boolean;
  accent?: boolean;
  tooltip?: string;
}) {
  // Auto-derive tooltip from the TIPS map when none is supplied — saves
  // every call site from spelling it out.
  const resolvedTooltip =
    tooltip ?? (label in TIPS ? TIPS[label as TipKey] : undefined);
  return (
    <div className="flex items-baseline justify-between gap-2 text-xs">
      <dt
        className={`flex-shrink-0 text-[var(--color-ink-muted)] ${
          resolvedTooltip ? 'cursor-help underline decoration-dotted underline-offset-2' : ''
        }`}
        title={resolvedTooltip}
      >
        {label}
      </dt>
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
