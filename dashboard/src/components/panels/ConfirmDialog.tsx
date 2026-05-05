'use client';

import { ReactNode, useEffect, useState } from 'react';

import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description: ReactNode;
  /** Phrase the operator must type verbatim to enable Confirm. */
  confirmText: string;
  /** Button label, defaults to 'Confirm'. */
  confirmLabel?: string;
  /** When true, the confirm button uses the destructive (red) accent. */
  destructive?: boolean;
  /** When true, both buttons are disabled while async work is in flight. */
  busy?: boolean;
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
}

/**
 * Reusable typed-confirm primitive for destructive group actions
 * (disable / delete). Wraps the existing Dialog and gates the confirm
 * button until the operator types `confirmText` verbatim. ESC closes
 * via the underlying Dialog.
 */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmText,
  confirmLabel = 'Confirm',
  destructive = false,
  busy = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const [input, setInput] = useState('');

  // Reset the input each time the dialog re-opens so a previous
  // typed phrase doesn't leak between confirmations.
  useEffect(() => {
    if (open) setInput('');
  }, [open]);

  const matches = input === confirmText;

  return (
    <Dialog open={open} onClose={busy ? () => {} : onCancel} title={title}>
      <div className="space-y-4">
        <div className="text-sm text-[var(--color-ink)]">{description}</div>

        <label className="block space-y-1.5">
          <span className="text-xs uppercase tracking-wider text-[var(--color-ink-muted)]">
            Type{' '}
            <span className="font-mono text-[var(--color-ink)]">
              {confirmText}
            </span>{' '}
            to confirm
          </span>
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            disabled={busy}
            autoFocus
            className="w-full rounded-xl border border-[var(--color-hairline)] bg-[var(--color-bg)] px-3 py-2 text-sm text-[var(--color-ink)] placeholder:text-[var(--color-ink-muted)] focus:border-[var(--color-ink)] focus:outline-none disabled:opacity-50"
          />
        </label>

        <div className="flex items-center justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              if (matches && !busy) void onConfirm();
            }}
            disabled={!matches || busy}
            className={
              destructive
                ? 'bg-red-600 text-white hover:bg-red-700 disabled:bg-red-600/50'
                : ''
            }
          >
            {busy ? 'Working…' : confirmLabel}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
