'use client';

import { type ReactNode, useEffect, useState } from 'react';

import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';

interface TypedConfirmModalProps {
  open: boolean;
  title: string;
  body: ReactNode;
  /** Operator must type this word verbatim to enable the confirm button. */
  confirmWord: string;
  /** Primary-button label, e.g. "Remove credential". */
  confirmLabel: string;
  onCancel: () => void;
  onConfirm: () => Promise<void>;
  /**
   * Confirmation tone — 'destructive' uses the danger colour palette
   * (red primary). 'default' uses the standard primary. Defaults to
   * 'destructive' because that's the common case (this component is
   * intended for irreversible actions).
   */
  tone?: 'destructive' | 'default';
}

/**
 * Typed-confirm modal — destructive-action gate.
 *
 * The operator must type the literal `confirmWord` to enable the
 * primary button. The pattern raises the cost of an accidental click
 * without falling back to a generic "Are you sure?" dialog that
 * operators dismiss reflexively.
 *
 * Mirrors the Doctor's Repair Stack confirmation idiom. Import this
 * from any future destructive action so the operator's mental model
 * stays consistent.
 *
 * Apple-philosophy heuristics applied (PROVIDER_PLAYBOOK § 7.6):
 *   - One primary action per screen — Cancel + Confirm; nothing else.
 *   - Status rendered, not counted — the input shows "type X to
 *     confirm"; the button state reflects the match boolean.
 *   - Instant feedback — typing renders the button-enable transition
 *     within React's commit phase (<16ms).
 *   - Reversible by default — Cancel is always available; Escape
 *     dismisses; the modal does NOT auto-fire on Enter unless the
 *     word matches.
 *   - Names beat IDs — `confirmWord` is the literal text the
 *     operator must type; surfaces in copy verbatim.
 */
export function TypedConfirmModal({
  open,
  title,
  body,
  confirmWord,
  confirmLabel,
  onCancel,
  onConfirm,
  tone = 'destructive',
}: TypedConfirmModalProps) {
  const [typed, setTyped] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset state when the modal reopens — operator who cancels and
  // re-opens shouldn't see stale typed text or an old error.
  useEffect(() => {
    if (open) {
      setTyped('');
      setError(null);
    }
  }, [open]);

  const matches = typed === confirmWord;

  async function handleConfirm() {
    if (!matches || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await onConfirm();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onClose={onCancel} title={title}>
      <div className="space-y-4">
        {body}
        <label className="block space-y-1">
          <span className="text-xs text-[var(--color-ink-muted)]">
            Type{' '}
            <strong className="font-mono text-[var(--color-ink)]">
              {confirmWord}
            </strong>{' '}
            to confirm
          </span>
          <input
            type="text"
            value={typed}
            autoFocus
            disabled={submitting}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && matches) void handleConfirm();
              if (e.key === 'Escape') onCancel();
            }}
            className="w-full rounded border border-[var(--color-hairline)] bg-[var(--color-bg)] px-2 py-1 font-mono text-sm text-[var(--color-ink)] focus:border-[var(--color-ink)] focus:outline-none"
            aria-label={`Type ${confirmWord} to confirm`}
          />
        </label>
        {error && (
          <p
            className="rounded border-l-2 border-[var(--color-danger)] bg-[var(--color-bg-subtle)] p-2 text-xs text-[var(--color-ink)]"
            role="alert"
          >
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onCancel} disabled={submitting}>
            Cancel
          </Button>
          <Button
            variant={tone === 'destructive' ? 'danger' : 'primary'}
            disabled={!matches || submitting}
            onClick={handleConfirm}
          >
            {submitting ? 'Working…' : confirmLabel}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
