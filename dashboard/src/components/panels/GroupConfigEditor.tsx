'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertTriangle } from 'lucide-react';

import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import {
  type Group,
  deleteGroup,
  disableGroup,
  enableGroup,
  groupVersionOf,
  isGroupDeleted,
  isGroupDisabled,
  patchGroup,
} from '@/lib/nanoclaw';
import { formatCostCents } from '@/lib/format';

import { ConfirmDialog } from './ConfirmDialog';

interface GroupConfigEditorProps {
  group: Group;
  /** Called after a successful mutation so the parent can re-fetch. */
  onSaved: () => void;
}

/**
 * Subset of HttpError we care about — the dashboard's nanoclaw client
 * throws an `Error` subclass that carries `status`, but it's not
 * exported. Sniff via duck typing.
 */
function statusOf(err: unknown): number | undefined {
  if (err && typeof err === 'object' && 'status' in err) {
    const s = (err as { status: unknown }).status;
    if (typeof s === 'number') return s;
  }
  return undefined;
}

const MODEL_CHOICES: { value: string; label: string }[] = [
  { value: '', label: '(default)' },
  { value: 'claude-haiku-4-5-20251001', label: 'haiku-4-5' },
  { value: 'claude-sonnet-4-6', label: 'sonnet-4-6' },
  { value: 'claude-opus-4-7', label: 'opus-4-7' },
];

interface OpenModeState {
  enabled: boolean;
  dailyBudgetCents: number;
}

interface EditorState {
  model: string; // '' = clear override
  requiresTrigger: boolean;
  openMode: OpenModeState;
}

function readOpenMode(group: Group): OpenModeState {
  const cfg = group.container_config as Record<string, unknown> | null;
  const om = cfg?.['openMode'] as Record<string, unknown> | undefined;
  return {
    enabled: typeof om?.['enabled'] === 'boolean' ? (om['enabled'] as boolean) : false,
    dailyBudgetCents:
      typeof om?.['dailyBudgetCents'] === 'number'
        ? (om['dailyBudgetCents'] as number)
        : 0,
  };
}

function readModel(group: Group): string {
  const cfg = group.container_config as Record<string, unknown> | null;
  const v = cfg?.['model'];
  return typeof v === 'string' ? v : '';
}

function snapshot(group: Group): EditorState {
  return {
    model: readModel(group),
    requiresTrigger: !!group.requires_trigger,
    openMode: readOpenMode(group),
  };
}

const COOLDOWN_SECONDS = 60;

export function GroupConfigEditor({ group, onSaved }: GroupConfigEditorProps) {
  const router = useRouter();

  const [state, setState] = useState<EditorState>(() => snapshot(group));
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<
    null | { kind: 'disable' } | { kind: 'delete' }
  >(null);
  const [reEnableCooldown, setReEnableCooldown] = useState(0);

  // Re-snapshot when the canonical group changes (parent re-fetch after a
  // save, version bump, or external edit).
  useEffect(() => {
    setState(snapshot(group));
  }, [group]);

  // Cooldown timer for the re-enable button after a disable.
  useEffect(() => {
    if (reEnableCooldown <= 0) return;
    const id = window.setInterval(() => {
      setReEnableCooldown((v) => (v > 0 ? v - 1 : 0));
    }, 1000);
    return () => window.clearInterval(id);
  }, [reEnableCooldown]);

  const original = useMemo(() => snapshot(group), [group]);
  const disabled = isGroupDisabled(group);
  const deleted = isGroupDeleted(group);

  const currentBudget = original.openMode.dailyBudgetCents;
  const newBudget = state.openMode.dailyBudgetCents;
  const showBudgetReductionNote =
    group.is_main &&
    state.openMode.enabled &&
    newBudget > 0 &&
    currentBudget > 0 &&
    newBudget < currentBudget;

  async function handleSave() {
    setBusy(true);
    setErrorMsg(null);
    setConflict(false);

    // Build the patch body. We always send openMode when this is the main
    // group (the only surface that exposes the toggle). Model uses an
    // empty string sentinel locally to mean "clear override"; the wire
    // format omits the field entirely in that case.
    const containerConfig: Record<string, unknown> = {};
    if (state.model) containerConfig.model = state.model;
    else containerConfig.model = null; // signal removal to backend
    if (group.is_main) {
      containerConfig.openMode = {
        enabled: state.openMode.enabled,
        dailyBudgetCents: state.openMode.dailyBudgetCents,
      };
    }

    try {
      await patchGroup(
        group.jid,
        {
          requires_trigger: state.requiresTrigger,
          container_config: containerConfig,
        },
        groupVersionOf(group),
      );
      onSaved();
    } catch (err) {
      const status = statusOf(err);
      if (status === 409) {
        setConflict(true);
        // Trigger a parent refetch so the editor rebases on canonical state.
        onSaved();
      } else {
        setErrorMsg(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setBusy(false);
    }
  }

  function handleReset() {
    setState(snapshot(group));
    setErrorMsg(null);
    setConflict(false);
  }

  async function handleDisableConfirmed() {
    setBusy(true);
    setErrorMsg(null);
    try {
      await disableGroup(group.jid, groupVersionOf(group));
      setConfirm(null);
      setReEnableCooldown(COOLDOWN_SECONDS);
      onSaved();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleEnable() {
    setBusy(true);
    setErrorMsg(null);
    try {
      await enableGroup(group.jid, groupVersionOf(group));
      onSaved();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleDeleteConfirmed() {
    setBusy(true);
    setErrorMsg(null);
    try {
      await deleteGroup(group.jid, groupVersionOf(group));
      setConfirm(null);
      router.push('/groups');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <div className="space-y-6">
          {conflict && (
            <div
              role="alert"
              className="flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-200"
            >
              <AlertTriangle
                className="mt-0.5 h-4 w-4 flex-shrink-0"
                aria-hidden="true"
              />
              <p>Group was edited elsewhere — reloading…</p>
            </div>
          )}

          {errorMsg && (
            <div
              role="alert"
              className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900 dark:border-red-900/40 dark:bg-red-950/30 dark:text-red-200"
            >
              {errorMsg}
            </div>
          )}

          <div className="space-y-2">
            <label
              htmlFor="model-select"
              className="text-xs uppercase tracking-wider text-[var(--color-ink-muted)]"
            >
              Model
            </label>
            <select
              id="model-select"
              value={state.model}
              onChange={(e) =>
                setState((s) => ({ ...s, model: e.target.value }))
              }
              disabled={busy || deleted}
              className="w-full max-w-sm rounded-xl border border-[var(--color-hairline)] bg-[var(--color-bg)] px-3 py-2 text-sm text-[var(--color-ink)] focus:border-[var(--color-ink)] focus:outline-none disabled:opacity-50"
            >
              {MODEL_CHOICES.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
            <p className="text-xs text-[var(--color-ink-muted)]">
              Clear to fall back to the orchestrator default.
            </p>
          </div>

          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-medium text-[var(--color-ink)]">
                Requires trigger
              </p>
              <p className="text-xs text-[var(--color-ink-muted)]">
                When on, only messages matching the trigger pattern reach the
                agent in this group.
              </p>
            </div>
            <label className="relative inline-flex cursor-pointer items-center">
              <input
                type="checkbox"
                checked={state.requiresTrigger}
                onChange={(e) =>
                  setState((s) => ({ ...s, requiresTrigger: e.target.checked }))
                }
                disabled={busy || deleted}
                className="peer sr-only"
              />
              <span className="h-6 w-11 rounded-full bg-[var(--color-hairline)] transition-colors peer-checked:bg-[var(--color-ink)] peer-disabled:opacity-50" />
              <span className="absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white transition-transform peer-checked:translate-x-5" />
            </label>
          </div>

          {group.is_main && (
            <div className="space-y-3 rounded-xl border border-[var(--color-hairline)] bg-[var(--color-bg-subtle)] p-4">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <p className="text-sm font-medium text-[var(--color-ink)]">
                    Open DM mode
                  </p>
                  <p className="text-xs text-[var(--color-ink-muted)]">
                    Allow direct messages to bypass the trigger up to the daily
                    spend cap.
                  </p>
                </div>
                <label className="relative inline-flex cursor-pointer items-center">
                  <input
                    type="checkbox"
                    checked={state.openMode.enabled}
                    onChange={(e) =>
                      setState((s) => ({
                        ...s,
                        openMode: {
                          ...s.openMode,
                          enabled: e.target.checked,
                        },
                      }))
                    }
                    disabled={busy || deleted}
                    className="peer sr-only"
                  />
                  <span className="h-6 w-11 rounded-full bg-[var(--color-hairline)] transition-colors peer-checked:bg-[var(--color-ink)] peer-disabled:opacity-50" />
                  <span className="absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white transition-transform peer-checked:translate-x-5" />
                </label>
              </div>

              <div className="space-y-1">
                <label
                  htmlFor="daily-budget"
                  className="text-xs uppercase tracking-wider text-[var(--color-ink-muted)]"
                >
                  Daily budget (cents)
                </label>
                <input
                  id="daily-budget"
                  type="number"
                  min={0}
                  step={1}
                  value={state.openMode.dailyBudgetCents}
                  onChange={(e) =>
                    setState((s) => ({
                      ...s,
                      openMode: {
                        ...s.openMode,
                        dailyBudgetCents: Number.isFinite(
                          e.target.valueAsNumber,
                        )
                          ? Math.max(0, Math.floor(e.target.valueAsNumber))
                          : 0,
                      },
                    }))
                  }
                  disabled={busy || deleted || !state.openMode.enabled}
                  className="w-full max-w-xs rounded-xl border border-[var(--color-hairline)] bg-[var(--color-bg)] px-3 py-2 text-sm text-[var(--color-ink)] focus:border-[var(--color-ink)] focus:outline-none disabled:opacity-50"
                />
                <p className="text-xs text-[var(--color-ink-muted)]">
                  Currently {formatCostCents(state.openMode.dailyBudgetCents)}{' '}
                  per day.
                </p>
              </div>

              {showBudgetReductionNote && (
                <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-200">
                  Reducing budget from {formatCostCents(currentBudget)} to{' '}
                  {formatCostCents(newBudget)}. Today&apos;s spend visible on
                  the Cost panel.
                </div>
              )}
            </div>
          )}

          <div className="flex items-center justify-end gap-2 border-t border-[var(--color-hairline)] pt-4">
            <Button
              variant="ghost"
              onClick={handleReset}
              disabled={busy || deleted}
            >
              Reset
            </Button>
            <Button onClick={handleSave} disabled={busy || deleted}>
              {busy ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </div>
      </Card>

      <Card>
        <div className="space-y-3">
          <div>
            <p className="text-sm font-medium text-[var(--color-ink)]">
              Lifecycle
            </p>
            <p className="text-xs text-[var(--color-ink-muted)]">
              Disable to silence the group temporarily; delete to remove it
              from routing. Soft-deleted groups stay in SQLite for v1.5
              restore.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {!disabled && !deleted && (
              <Button
                variant="ghost"
                onClick={() => setConfirm({ kind: 'disable' })}
                disabled={busy}
              >
                Disable
              </Button>
            )}
            {disabled && !deleted && (
              <div className="flex items-center gap-3">
                <Button
                  variant="ghost"
                  onClick={handleEnable}
                  disabled={busy || reEnableCooldown > 0}
                >
                  {reEnableCooldown > 0
                    ? `Re-enable available in ${reEnableCooldown}s`
                    : 'Re-enable'}
                </Button>
                <Badge variant="warning">Disabled</Badge>
              </div>
            )}
            {!deleted && (
              <Button
                variant="ghost"
                onClick={() => setConfirm({ kind: 'delete' })}
                disabled={busy}
                className="border-red-300 text-red-700 hover:bg-red-50 dark:border-red-900/40 dark:text-red-300 dark:hover:bg-red-950/30"
              >
                Delete
              </Button>
            )}
            {deleted && <Badge variant="error">Soft-deleted</Badge>}
          </div>
        </div>
      </Card>

      <ConfirmDialog
        open={confirm?.kind === 'disable'}
        title="Disable group"
        description={
          <p>
            This will silence{' '}
            <span className="font-medium">{group.name || group.folder}</span>.
            Existing scheduled tasks will be paused. Re-enable becomes
            available after {COOLDOWN_SECONDS} seconds.
          </p>
        }
        confirmText={group.name || group.folder}
        confirmLabel="Disable"
        busy={busy}
        onConfirm={handleDisableConfirmed}
        onCancel={() => setConfirm(null)}
      />

      <ConfirmDialog
        open={confirm?.kind === 'delete'}
        title="Delete group"
        description={
          <p>
            Soft-deletes{' '}
            <span className="font-medium">{group.name || group.folder}</span>{' '}
            from the routing map. The folder and SQLite history remain for
            v1.5 restore.
          </p>
        }
        confirmText={group.name || group.folder}
        confirmLabel="Delete"
        destructive
        busy={busy}
        onConfirm={handleDeleteConfirmed}
        onCancel={() => setConfirm(null)}
      />
    </div>
  );
}
