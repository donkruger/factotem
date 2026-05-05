'use client';

import { Fragment, useCallback, useMemo, useState } from 'react';
import { Undo2, RefreshCw } from 'lucide-react';

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
        <div className="flex items-center gap-3">
          {entries && entries.length > 0 && (
            <Badge variant="neutral">
              {entries.length} entr{entries.length === 1 ? 'y' : 'ies'}
              {sinceLabel ? ` · ${sinceLabel}` : ''}
            </Badge>
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
                          <td colSpan={5} className="px-4 py-3">
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
