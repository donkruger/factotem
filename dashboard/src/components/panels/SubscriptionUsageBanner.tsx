'use client';

import { Info } from 'lucide-react';

/**
 * Shown on the Usage page when the deployment runs on a Claude subscription
 * / OAuth token (see `isUsageMode`). Explains why dollar costs aren't shown:
 * subscription plans aren't metered per token, and from 2026-06-15 Agent-SDK
 * usage draws from a separate capped monthly credit accounted server-side by
 * Anthropic — so the host can only observe token volume, not spend.
 *
 * Factual and non-alarming: this is the expected steady state for a
 * subscription-token deployment, not an error.
 */
export function SubscriptionUsageBanner() {
  return (
    <div
      role="note"
      className="flex items-start gap-3 rounded-2xl border border-[var(--color-hairline)] bg-[var(--color-bg-subtle)] px-6 py-4 text-[var(--color-ink)]"
    >
      <Info className="mt-0.5 h-5 w-5 flex-shrink-0 text-[var(--color-ink-muted)]" aria-hidden="true" />
      <div className="flex-1 space-y-1.5">
        <p className="text-sm font-medium">Running on a Claude subscription token</p>
        <p className="text-xs text-[var(--color-ink-muted)]">
          Per-token dollar costs aren&apos;t metered on a subscription plan, so this
          page shows <strong className="text-[var(--color-ink)]">token usage</strong> and
          turn counts instead of spend. From 15 June 2026, Agent-SDK usage draws
          from a separate capped monthly credit (Pro $20 · Max 5× $100 · Max 20× $200,
          no rollover) accounted by Anthropic — token volume here is the local proxy
          for how much of that credit you&apos;re consuming.
        </p>
      </div>
    </div>
  );
}
