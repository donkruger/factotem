'use client';

import { useEffect, useState } from 'react';
import { Power } from 'lucide-react';

import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from './ConfirmDialog';
import { postRestartStack } from '@/lib/nanoclaw';

interface RestartStackButtonProps {
  enabled: boolean;
  /** Called after a successful restart so the parent can re-poll. */
  onCompleted?: () => void;
}

/**
 * Operator action: SIGKILLs Docker Desktop + the docker backend so that
 * launchd respawns them clean. Hidden by default — only renders when
 * `enabled` is true (the orchestrator gates this on a server-side feature
 * flag so we don't accidentally expose it to non-operator dashboards).
 *
 * Wraps the existing typed-confirm dialog. The operator must type
 * `RESTART STACK` verbatim before the destructive button activates.
 */
export function RestartStackButton({
  enabled,
  onCompleted,
}: RestartStackButtonProps) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successAt, setSuccessAt] = useState<number | null>(null);

  // Auto-clear the success banner after 5 seconds.
  useEffect(() => {
    if (successAt === null) return;
    const id = setTimeout(() => setSuccessAt(null), 5_000);
    return () => clearTimeout(id);
  }, [successAt]);

  if (!enabled) return null;

  const handleConfirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await postRestartStack();
      setOpen(false);
      setSuccessAt(Date.now());
      if (onCompleted) onCompleted();
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : 'Restart failed (unknown error)';
      setError(msg);
    } finally {
      setBusy(false);
    }
  };

  const handleCancel = () => {
    if (busy) return;
    setOpen(false);
    setError(null);
  };

  return (
    <>
      <div className="flex flex-col items-end gap-2">
        <Button
          variant="primary"
          onClick={() => {
            setError(null);
            setOpen(true);
          }}
          className="bg-red-600 text-white hover:bg-red-700"
        >
          <Power className="h-4 w-4" aria-hidden="true" />
          Restart Stack
        </Button>
        {successAt !== null && (
          <span
            role="status"
            className="rounded-pill bg-emerald-100 px-3 py-1 text-xs font-medium text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300"
          >
            Restart Stack invoked — Docker should be back within 10 seconds
          </span>
        )}
      </div>

      <ConfirmDialog
        open={open}
        title="Restart the Docker stack?"
        description={
          <div className="space-y-3">
            <p>
              This SIGKILLs Docker Desktop and the docker backend. launchd
              respawns them automatically — Docker should be reachable again
              within roughly 10 seconds.
            </p>
            <p className="text-[var(--color-ink-muted)]">
              Any in-flight container turns will fail mid-call. The dashboard
              will re-poll once the stack is back.
            </p>
            {error && (
              <p className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900/40 dark:bg-red-950/30 dark:text-red-200">
                {error}
              </p>
            )}
          </div>
        }
        confirmText="RESTART STACK"
        confirmLabel="Restart Stack"
        destructive
        busy={busy}
        onConfirm={handleConfirm}
        onCancel={handleCancel}
      />
    </>
  );
}
