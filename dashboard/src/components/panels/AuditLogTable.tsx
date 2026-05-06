'use client';

import { Fragment, useCallback, useMemo, useState } from 'react';
import { Download, FileText, Undo2, RefreshCw } from 'lucide-react';

import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
} from '@/components/ui/Table';

import { ConfirmDialog } from './ConfirmDialog';
import { ConnectionLossBanner } from './ConnectionLossBanner';
import { usePoll } from '@/hooks/usePoll';
import {
  type AuditEntry,
  getAudit,
  postAuditUndo,
} from '@/lib/nanoclaw';
import { formatRelativeTime } from '@/lib/format';

const POLL_INTERVAL_MS = 30_000;

const ACTION_LABELS: Record<string, string> = {
  'group.config.update': 'Config update',
  'group.disable': 'Disable',
  'group.enable': 'Enable',
  'group.delete': 'Delete',
  'profile.update': 'Profile update',
  'openMode.update': 'openMode update',
  'test_message.send': 'Test message',
  'restart_stack.invoke': 'Restart Stack',
  'audit.undo': 'Undo',
};

function actionLabel(action: string): string {
  return ACTION_LABELS[action] ?? action;
}

function isJid(target: string | null | undefined): target is string {
  if (!target) return false;
  return /@(g\.us|s\.whatsapp\.net|lid)$/.test(target);
}

interface ReversibleState {
  state: 'reversible' | 'expired' | 'none';
  until?: string;
}

function reversibleState(entry: AuditEntry, now: number): ReversibleState {
  if (!entry.reversible_until) return { state: 'none' };
  const ts = Date.parse(entry.reversible_until);
  if (!Number.isFinite(ts)) return { state: 'none' };
  if (ts > now) return { state: 'reversible', until: entry.reversible_until };
  return { state: 'expired', until: entry.reversible_until };
}

function formatAbsoluteTime(iso: string): string {
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return iso;
  return new Date(ts).toLocaleString();
}

function formatTimeOfDay(iso: string): string {
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return iso;
  return new Date(ts).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Derive a one-line human-readable summary of what an audit entry did.
 * Best-effort — falls back to the raw action when we can't parse the
 * payloads. Examples:
 *   "Renamed group → 'Richard Nel (DM)'"
 *   "Disabled group"
 *   "Restart Stack invoked"
 *   "Test message sent"
 */
function summarise(entry: AuditEntry): string {
  const parsedBefore = tryParseJson(entry.payload_before);
  const parsedAfter = tryParseJson(entry.payload_after);
  switch (entry.action) {
    case 'group.config.update': {
      // Compare each editable field. Most common operator action: renamed.
      const before = (parsedBefore ?? {}) as Record<string, unknown>;
      const after = (parsedAfter ?? {}) as Record<string, unknown>;
      const diffs: string[] = [];
      if (
        typeof before.name === 'string' &&
        typeof after.name === 'string' &&
        before.name !== after.name
      ) {
        diffs.push(`name → '${after.name}'`);
      }
      if (
        typeof before.trigger === 'string' &&
        typeof after.trigger === 'string' &&
        before.trigger !== after.trigger
      ) {
        diffs.push(`trigger → '${after.trigger}'`);
      }
      if (
        typeof before.requiresTrigger === 'boolean' &&
        typeof after.requiresTrigger === 'boolean' &&
        before.requiresTrigger !== after.requiresTrigger
      ) {
        diffs.push(`requires_trigger → ${after.requiresTrigger}`);
      }
      // Container config diff (model, openMode, etc.)
      const cfgBefore =
        (before.containerConfig as Record<string, unknown> | null) ?? {};
      const cfgAfter =
        (after.containerConfig as Record<string, unknown> | null) ?? {};
      for (const k of Object.keys(cfgAfter)) {
        if (k === 'version') continue; // server-managed
        const a = JSON.stringify(cfgAfter[k]);
        const b = JSON.stringify((cfgBefore as Record<string, unknown>)[k]);
        if (a !== b) diffs.push(`config.${k} → ${truncate(a, 50)}`);
      }
      if (diffs.length === 0) return 'No-op config update';
      return `Updated group: ${diffs.join(', ')}`;
    }
    case 'group.disable':
      return 'Disabled group';
    case 'group.enable':
      return 'Enabled group';
    case 'group.delete':
      return 'Soft-deleted group';
    case 'profile.update':
      return 'Updated profile';
    case 'openMode.update':
      return 'Updated openMode config';
    case 'test_message.send': {
      const after = (parsedAfter ?? {}) as Record<string, unknown>;
      if (after && after.kind === 'cost_alert_test') {
        return 'Cost alert test fired';
      }
      const text = typeof after?.text === 'string' ? after.text : '';
      if (text) return `Test message: '${truncate(text, 40)}'`;
      return 'Test message sent';
    }
    case 'restart_stack.invoke':
      return 'Restart Stack invoked';
    case 'audit.undo':
      return 'Reverted a previous change';
    default:
      return entry.action;
  }
}

function tryParseJson(s: string | null | undefined): unknown {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + '…';
}

function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function buildCsv(entries: AuditEntry[]): string {
  const cols = [
    'id',
    'ts',
    'action',
    'target',
    'reversible_until',
    'summary',
    'payload_before',
    'payload_after',
  ] as const;
  const rows = [cols.join(',')];
  for (const e of entries) {
    rows.push(
      cols
        .map((c) => {
          if (c === 'summary') return csvEscape(summarise(e));
          return csvEscape((e as unknown as Record<string, unknown>)[c]);
        })
        .join(','),
    );
  }
  return rows.join('\n');
}

function buildJson(entries: AuditEntry[]): string {
  const enriched = entries.map((e) => ({
    ...e,
    summary: summarise(e),
    parsed_payload_before: tryParseJson(e.payload_before),
    parsed_payload_after: tryParseJson(e.payload_after),
  }));
  return JSON.stringify(
    {
      generated_at: new Date().toISOString(),
      count: enriched.length,
      entries: enriched,
    },
    null,
    2,
  );
}

/**
 * Audit Log panel: reverse-chronological view of state-changing operations
 * recorded in the `audit_log` table. Polled every 30s. Rows whose
 * `reversible_until` is still in the future expose an Undo button that
 * runs through a typed-confirm dialog and hits `POST /api/audit/{id}/undo`.
 *
 * T-1778244000000 (Wave 7 part 2 of the Factotem Dashboard v1 epic).
 */
export function AuditLogTable() {
  const [refreshNonce, setRefreshNonce] = useState(0);
  const fetchAudit = useCallback(
    () => getAudit({ limit: 200 }),
    // refreshNonce is intentionally a dependency so the manual refresh
    // button forces a re-fetch even mid-interval.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [refreshNonce],
  );
  const { data: entries, error, loading } = usePoll<AuditEntry[]>(
    fetchAudit,
    POLL_INTERVAL_MS,
  );
  const bumpRefresh = () => setRefreshNonce((n) => n + 1);

  // Per-row expand state for the payload preview.
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});
  const toggleExpanded = (id: number) =>
    setExpanded((prev) => ({ ...prev, [id]: !prev[id] }));

  // Undo confirm dialog state.
  const [undoTarget, setUndoTarget] = useState<AuditEntry | null>(null);
  const [undoBusy, setUndoBusy] = useState(false);
  const [undoError, setUndoError] = useState<string | null>(null);

  const openUndo = (entry: AuditEntry) => {
    setUndoTarget(entry);
    setUndoError(null);
  };
  const closeUndo = () => {
    if (undoBusy) return;
    setUndoTarget(null);
    setUndoError(null);
  };
  const confirmUndo = async () => {
    if (!undoTarget) return;
    setUndoBusy(true);
    setUndoError(null);
    try {
      await postAuditUndo(undoTarget.id);
      setUndoTarget(null);
      bumpRefresh();
    } catch (err) {
      setUndoError((err as Error).message);
    } finally {
      setUndoBusy(false);
    }
  };

  const now = Date.now();
  const sinceLabel = useMemo(() => {
    if (!entries || entries.length === 0) return null;
    let oldest = Number.POSITIVE_INFINITY;
    for (const e of entries) {
      const ts = Date.parse(e.ts);
      if (Number.isFinite(ts) && ts < oldest) oldest = ts;
    }
    if (!Number.isFinite(oldest)) return null;
    const days = Math.max(1, Math.round((now - oldest) / (24 * 60 * 60 * 1000)));
    return `last ${days} day${days === 1 ? '' : 's'}`;
  }, [entries, now]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-medium tracking-tight text-[var(--color-ink)]">
            Audit Log
          </h1>
          <p className="mt-2 text-sm text-[var(--color-ink-muted)]">
            Reverse-chronological record of state-changing operations. Polled
            every 30 seconds.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {entries && entries.length > 0 && (
            <Badge variant="neutral">
              {entries.length} entr{entries.length === 1 ? 'y' : 'ies'}
              {sinceLabel ? ` · ${sinceLabel}` : ''}
            </Badge>
          )}
          {entries && entries.length > 0 && (
            <>
              <a
                href={`data:text/csv;charset=utf-8,${encodeURIComponent(buildCsv(entries))}`}
                download={`audit-log-${new Date().toISOString().slice(0, 10)}.csv`}
                className="inline-flex items-center gap-2 rounded-pill border border-[var(--color-hairline)] bg-[var(--color-bg)] px-4 py-2 text-sm text-[var(--color-ink)] transition-colors hover:bg-[var(--color-bg-subtle)]"
              >
                <Download className="h-4 w-4" aria-hidden="true" />
                CSV
              </a>
              <a
                href={`data:application/json;charset=utf-8,${encodeURIComponent(buildJson(entries))}`}
                download={`audit-log-${new Date().toISOString().slice(0, 10)}.json`}
                className="inline-flex items-center gap-2 rounded-pill border border-[var(--color-hairline)] bg-[var(--color-bg)] px-4 py-2 text-sm text-[var(--color-ink)] transition-colors hover:bg-[var(--color-bg-subtle)]"
              >
                <FileText className="h-4 w-4" aria-hidden="true" />
                JSON
              </a>
            </>
          )}
          <Button
            type="button"
            variant="ghost"
            onClick={bumpRefresh}
            disabled={loading && !entries}
            className="px-4 py-2"
          >
            <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
            Refresh
          </Button>
        </div>
      </div>

      {error && <ConnectionLossBanner error={error} />}

      <Card>
        <div className="space-y-2 text-xs text-[var(--color-ink-muted)]">
          <p>
            <span className="font-medium text-[var(--color-ink)]">
              Why this log exists.
            </span>{' '}
            Every state-changing operation hitting `/api/*` (group config
            edits, disable / enable / delete, test messages, Restart Stack
            invocations) writes one row here with the before / after
            payloads and a reversibility window.
          </p>
          <p>
            <span className="font-medium text-[var(--color-ink)]">
              Why it&apos;s useful.
            </span>{' '}
            Three things at once:
          </p>
          <ul className="list-disc space-y-1 pl-5">
            <li>
              <span className="font-medium">Undo for recent mistakes.</span>{' '}
              The Undo button restores the prior payload while the action is
              still within its reversibility window (5 min for config edits,
              24 h for disable / delete).
            </li>
            <li>
              <span className="font-medium">Forensic record</span> for when
              the system behaves unexpectedly. Click any row to expand and
              see the exact bytes that changed.
            </li>
            <li>
              <span className="font-medium">Forward-compatible audit
              trail</span> for v1.5 multi-operator deployments. The `actor`
              column already lives on disk; v1 just always says
              `&apos;operator&apos;`.
            </li>
          </ul>
          <p className="pt-1">
            Click a row to expand the JSON payloads. Use the CSV / JSON
            export to hand the audit trail to an agent for analysis.
          </p>
        </div>
      </Card>

      {loading && !entries && !error && (
        <Card>
          <p className="text-sm text-[var(--color-ink-muted)]">
            Loading audit log…
          </p>
        </Card>
      )}

      {entries && entries.length === 0 && (
        <Card>
          <div className="space-y-2">
            <p className="text-sm text-[var(--color-ink)]">
              No audit entries yet.
            </p>
            <p className="text-xs text-[var(--color-ink-muted)]">
              Operations on the Group Management or Cost panels show up here.
            </p>
          </div>
        </Card>
      )}

      {entries && entries.length > 0 && (
        <Card>
          <div className="-mx-6 -my-6">
            <Table>
              <TableHead>
                <TableRow>
                  <TableCell header>When</TableCell>
                  <TableCell header>Action</TableCell>
                  <TableCell header>Summary</TableCell>
                  <TableCell header>Target</TableCell>
                  <TableCell header>Reversible</TableCell>
                  <TableCell header className="text-right">
                    Actions
                  </TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {entries.map((entry) => {
                  const rev = reversibleState(entry, now);
                  const isExpanded = !!expanded[entry.id];
                  const targetIsJid = isJid(entry.target);
                  return (
                    <Fragment key={entry.id}>
                      <TableRow
                        onClick={() => toggleExpanded(entry.id)}
                        className="cursor-pointer"
                      >
                        <TableCell className="whitespace-nowrap text-xs text-[var(--color-ink-muted)]">
                          <time
                            dateTime={entry.ts}
                            title={formatAbsoluteTime(entry.ts)}
                          >
                            {formatRelativeTime(entry.ts)}
                          </time>
                        </TableCell>
                        <TableCell>
                          <Badge variant="neutral">
                            {actionLabel(entry.action)}
                          </Badge>
                        </TableCell>
                        <TableCell className="max-w-[360px] truncate text-sm text-[var(--color-ink)]">
                          {summarise(entry)}
                        </TableCell>
                        <TableCell className="max-w-[280px] truncate font-mono text-xs">
                          {entry.target ? (
                            targetIsJid ? (
                              <a
                                href={`/groups/${encodeURIComponent(entry.target)}`}
                                onClick={(e) => e.stopPropagation()}
                                className="text-[var(--color-ink)] underline decoration-[var(--color-hairline)] underline-offset-2 hover:decoration-[var(--color-ink)]"
                              >
                                {entry.target}
                              </a>
                            ) : (
                              <span className="text-[var(--color-ink)]">
                                {entry.target}
                              </span>
                            )
                          ) : (
                            <span className="text-[var(--color-ink-muted)]">
                              —
                            </span>
                          )}
                        </TableCell>
                        <TableCell>
                          {rev.state === 'reversible' && (
                            <Badge variant="success">
                              Reversible until {formatTimeOfDay(rev.until!)}
                            </Badge>
                          )}
                          {rev.state === 'none' && (
                            <span className="text-xs text-[var(--color-ink-muted)]">
                              —
                            </span>
                          )}
                          {rev.state === 'expired' && (
                            <Badge variant="neutral">Expired</Badge>
                          )}
                        </TableCell>
                        <TableCell className="text-right">
                          {rev.state === 'reversible' ? (
                            <Button
                              type="button"
                              variant="ghost"
                              onClick={(e) => {
                                e.stopPropagation();
                                openUndo(entry);
                              }}
                              className="px-3 py-1.5 text-xs"
                            >
                              <Undo2
                                className="h-3.5 w-3.5"
                                aria-hidden="true"
                              />
                              Undo
                            </Button>
                          ) : (
                            <span className="text-xs text-[var(--color-ink-muted)]">
                              —
                            </span>
                          )}
                        </TableCell>
                      </TableRow>
                      {isExpanded && (
                        <tr className="border-t border-[var(--color-hairline)] bg-[var(--color-bg-subtle)]">
                          <td colSpan={6} className="px-4 py-3">
                            <PayloadPreview entry={entry} />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        </Card>
      )}

      <ConfirmDialog
        open={undoTarget !== null}
        title="Undo this change?"
        description={
          <div className="space-y-2">
            <p>
              {undoTarget ? (
                <>
                  This will reverse{' '}
                  <span className="font-mono text-[var(--color-ink)]">
                    {undoTarget.action}
                  </span>{' '}
                  on{' '}
                  <span className="font-mono text-[var(--color-ink)]">
                    {undoTarget.target ?? '—'}
                  </span>
                  . A new audit row will be written marking this as an undo of
                  #{undoTarget.id}.
                </>
              ) : null}
            </p>
            {undoError && (
              <p className="text-xs text-red-700 dark:text-red-300">
                Undo failed: {undoError}
              </p>
            )}
          </div>
        }
        confirmText="UNDO"
        confirmLabel="Undo"
        destructive={false}
        busy={undoBusy}
        onConfirm={confirmUndo}
        onCancel={closeUndo}
      />
    </div>
  );
}

function PayloadPreview({ entry }: { entry: AuditEntry }) {
  return (
    <div className="grid gap-3 md:grid-cols-2">
      <div>
        <p className="mb-1 text-[11px] uppercase tracking-wider text-[var(--color-ink-muted)]">
          payload_before
        </p>
        <pre className="max-h-64 overflow-auto rounded-xl border border-[var(--color-hairline)] bg-[var(--color-bg)] px-3 py-2 font-mono text-[11px] leading-snug text-[var(--color-ink)]">
{formatJsonString(entry.payload_before)}
        </pre>
      </div>
      <div>
        <p className="mb-1 text-[11px] uppercase tracking-wider text-[var(--color-ink-muted)]">
          payload_after
        </p>
        <pre className="max-h-64 overflow-auto rounded-xl border border-[var(--color-hairline)] bg-[var(--color-bg)] px-3 py-2 font-mono text-[11px] leading-snug text-[var(--color-ink)]">
{formatJsonString(entry.payload_after)}
        </pre>
      </div>
    </div>
  );
}

function formatJsonString(raw: string | null | undefined): string {
  if (!raw) return '(none)';
  try {
    const parsed = JSON.parse(raw);
    return JSON.stringify(parsed, null, 2);
  } catch {
    return raw;
  }
}
