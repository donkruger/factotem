'use client';

import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { deleteCredential, getOrphanedCredentials } from '@/lib/nanoclaw';
import { TypedConfirmModal } from './TypedConfirmModal';

const POLL_INTERVAL_MS = 30_000;
const SESSION_DISMISSED_KEY = 'orphan-credentials-dismissed';

/**
 * OrphanCredentialsBanner — soft-amber card on /agents listing
 * OneCLI credentials no longer referenced by any agent.
 *
 * Per multi-agent-completion § 5.1, we never auto-delete; the
 * operator confirms each removal via the TypedConfirmModal (mirrors
 * the Doctor's Repair Stack idiom).
 *
 * Apple-philosophy heuristics (PROVIDER_PLAYBOOK § 7.6):
 *   - One primary action per row — Remove. Dismiss is secondary.
 *   - Status rendered, not counted — prose copy ("The Gemini
 *     credential is no longer used by any agent") rather than a
 *     count badge.
 *   - Names beat IDs — credential names render verbatim in copy.
 *   - Reversible by default — typed-confirm raises the click's cost
 *     enough that accidental triggers don't happen; the actual
 *     delete is one-way (the operator would re-paste the API key
 *     via the wizard if regretted, hence the typed gate).
 *   - Empty state teaches — no orphans → component returns null;
 *     no nag on a healthy deployment.
 *   - Dismissable per session — operators who deliberately keep
 *     credentials around aren't nagged on every poll.
 */
export function OrphanCredentialsBanner() {
  const [orphans, setOrphans] = useState<string[]>([]);
  const [dismissed, setDismissed] = useState<Set<string>>(() => {
    if (typeof window === 'undefined') return new Set();
    try {
      const raw = sessionStorage.getItem(SESSION_DISMISSED_KEY);
      return raw ? new Set(JSON.parse(raw) as string[]) : new Set();
    } catch {
      return new Set();
    }
  });
  const [target, setTarget] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function poll() {
      try {
        const candidates = await getOrphanedCredentials();
        if (!cancelled) setOrphans(candidates);
      } catch {
        /* swallow — polling failures shouldn't surface as red */
      }
    }
    void poll();
    const t = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  function dismiss(name: string) {
    const next = new Set(dismissed);
    next.add(name);
    setDismissed(next);
    try {
      sessionStorage.setItem(
        SESSION_DISMISSED_KEY,
        JSON.stringify([...next]),
      );
    } catch {
      /* sessionStorage may be unavailable (private mode); silent */
    }
  }

  const visible = orphans.filter((n) => !dismissed.has(n));
  if (visible.length === 0) return null;

  return (
    <>
      <Card>
        <div
          className="space-y-3 border-l-4 border-[var(--color-warning)] p-4"
          role="region"
          aria-label="Unused credentials"
        >
          <h3 className="text-sm font-medium text-[var(--color-ink)]">
            Unused credentials
          </h3>
          {visible.map((name) => (
            <div
              key={name}
              className="flex flex-col items-start justify-between gap-3 sm:flex-row sm:items-center"
            >
              <p className="text-sm text-[var(--color-ink-muted)]">
                The{' '}
                <strong className="font-mono text-[var(--color-ink)]">
                  {name}
                </strong>{' '}
                credential is no longer used by any agent. Remove it
                from the OneCLI vault, or dismiss to keep it.
              </p>
              <div className="flex flex-shrink-0 gap-2">
                <Button variant="ghost" onClick={() => dismiss(name)}>
                  Dismiss
                </Button>
                <Button variant="danger" onClick={() => setTarget(name)}>
                  Remove →
                </Button>
              </div>
            </div>
          ))}
        </div>
      </Card>
      {target && (
        <TypedConfirmModal
          open
          title={`Remove "${target}"`}
          body={
            <p className="text-sm text-[var(--color-ink-muted)]">
              This deletes the credential from your OneCLI vault.
              If you later want to re-add an agent using{' '}
              <strong className="text-[var(--color-ink)]">{target}</strong>,
              you&apos;ll need to paste the API key again via the
              setup wizard.
            </p>
          }
          confirmWord={target}
          confirmLabel={`Remove ${target}`}
          tone="destructive"
          onCancel={() => setTarget(null)}
          onConfirm={async () => {
            await deleteCredential(target);
            setOrphans((prev) => prev.filter((n) => n !== target));
            setTarget(null);
          }}
        />
      )}
    </>
  );
}
