'use client';

import { useCallback, useEffect, useState } from 'react';

import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { useAuthMode } from '@/hooks/useAuthMode';
import {
  type AgentDetail,
  type ChannelPairing,
  getPairings,
  patchAgent,
} from '@/lib/nanoclaw';

/**
 * AgentPairingAndBudget — sits on the per-agent detail page.
 *
 * Two side-by-side concerns the operator manages most often after the
 * agent is created: which WhatsApp pairing the agent answers from
 * (multi-agent-completion § 4.1) and the daily spend cap
 * (§ 4.2). Both are inline-editable; both write through the same
 * PATCH /api/agents/:id endpoint.
 *
 * Apple-philosophy heuristics applied:
 *   - One primary action per field (dropdown for pairing, single
 *     numeric input for budget).
 *   - Status rendered, not counted: the budget meter renders the
 *     current usage as a progress bar (green / amber / red), not a
 *     bare "spent X / Y" line.
 *   - Deferred disclosure: technical details (auth_path, raw cents)
 *     stay in tooltips.
 *   - Direct manipulation: clicking the budget value opens an inline
 *     editor; pressing Enter commits, Escape cancels.
 *   - Reversibility: every budget change writes an
 *     agent.budget.update audit row that operators can undo for 5
 *     minutes from the Audit page.
 */
export function AgentPairingAndBudget({
  agent,
  onChange,
}: {
  agent: AgentDetail;
  onChange?: () => void;
}) {
  // On a subscription/oauth token there's no per-token dollar billing, so a
  // $ daily cap can never trip (est_cost is always 0) — Anthropic enforces
  // the monthly Agent-SDK credit server-side. Replace the budget editor with
  // a short explainer rather than show an inert control.
  const { usageMode } = useAuthMode();
  return (
    <Card>
      <div className="grid grid-cols-1 gap-5 p-5 md:grid-cols-2">
        <PairingField agent={agent} onChange={onChange} />
        {usageMode ? <BudgetUnavailable /> : <BudgetField agent={agent} onChange={onChange} />}
      </div>
    </Card>
  );
}

// --- Budget unavailable (subscription/oauth) ------------------------------

function BudgetUnavailable() {
  return (
    <div className="space-y-2">
      <h3 className="text-[10px] font-semibold uppercase tracking-wider text-[var(--color-ink-muted)]">
        Daily budget
      </h3>
      <p className="text-sm text-[var(--color-ink)]">Not applicable</p>
      <p className="text-xs text-[var(--color-ink-muted)]">
        This deployment uses a Claude subscription token, which isn&apos;t
        metered per token — a dollar cap can&apos;t be enforced locally.
        Anthropic enforces the monthly Agent-SDK credit server-side. Track
        consumption via token usage on the Usage page.
      </p>
    </div>
  );
}

// --- Pairing field --------------------------------------------------------

function PairingField({
  agent,
  onChange,
}: {
  agent: AgentDetail;
  onChange?: () => void;
}) {
  const [pairings, setPairings] = useState<ChannelPairing[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void getPairings()
      .then(setPairings)
      .catch((err) => setError((err as Error).message));
  }, []);

  const currentId = agent.channel_pairing_id ?? agent.pairing?.id ?? null;
  const targetId = pendingId ?? currentId ?? '';
  const dirty = pendingId !== null && pendingId !== currentId;

  async function commit() {
    if (!dirty || !pendingId) return;
    setSaving(true);
    try {
      await patchAgent(agent.id, { channel_pairing_id: pendingId });
      setPendingId(null);
      onChange?.();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-2">
      <h3 className="text-[10px] font-semibold uppercase tracking-wider text-[var(--color-ink-muted)]">
        WhatsApp pairing
      </h3>
      {agent.pairing && (
        <p className="text-sm text-[var(--color-ink)]" title={agent.pairing.auth_path}>
          {agent.pairing.display_name}
          {agent.pairing.is_shared && (
            <Badge className="ml-2">Shared</Badge>
          )}
        </p>
      )}
      {agent.pairing?.phone_hint && (
        <p className="font-mono text-xs text-[var(--color-ink-muted)]">
          {agent.pairing.phone_hint}
        </p>
      )}
      {pairings && pairings.length > 1 && (
        <div className="flex items-center gap-2 pt-1">
          <select
            value={targetId}
            disabled={saving}
            onChange={(e) => setPendingId(e.target.value)}
            className="rounded border border-[var(--color-hairline)] px-2 py-1 text-xs text-[var(--color-ink)]"
          >
            {pairings.map((p) => (
              <option key={p.id} value={p.id}>
                {p.display_name}
                {p.is_shared ? ' (shared)' : ''}
              </option>
            ))}
          </select>
          {dirty && (
            <Button
              variant="primary"
              onClick={commit}
              disabled={saving}
            >
              {saving ? 'Saving…' : 'Switch'}
            </Button>
          )}
        </div>
      )}
      {pairings && pairings.length <= 1 && (
        <p className="text-xs text-[var(--color-ink-muted)]">
          Only one WhatsApp pairing is configured. Add another from the
          setup wizard to give this agent its own number.
        </p>
      )}
      {!pairings && !error && (
        <p className="text-xs text-[var(--color-ink-muted)]">Loading pairings…</p>
      )}
      {error && (
        <p className="text-xs text-[var(--color-danger)]">{error}</p>
      )}
    </div>
  );
}

// --- Budget field ---------------------------------------------------------

function BudgetField({
  agent,
  onChange,
}: {
  agent: AgentDetail;
  onChange?: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [valueDollars, setValueDollars] = useState<string>(
    agent.daily_budget_cents != null
      ? (agent.daily_budget_cents / 100).toFixed(2)
      : '',
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const capCents = agent.daily_budget_cents ?? null;
  const spentCents = agent.spent_today_cents ?? 0;
  const capDollars = capCents != null ? capCents / 100 : null;
  const spentDollars = spentCents / 100;
  const fraction = capCents && capCents > 0 ? spentCents / capCents : 0;
  const meterColor =
    fraction >= 1
      ? 'var(--color-danger)'
      : fraction >= 0.75
        ? 'var(--color-warning)'
        : 'var(--color-success)';

  const commit = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      const cents =
        valueDollars.trim() === ''
          ? null
          : Math.max(0, Math.round(parseFloat(valueDollars) * 100));
      if (cents !== null && !Number.isFinite(cents)) {
        setError('Enter a number, e.g. 5.00');
        return;
      }
      await patchAgent(agent.id, { daily_budget_cents: cents });
      setEditing(false);
      onChange?.();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }, [agent.id, onChange, valueDollars]);

  return (
    <div className="space-y-2">
      <h3 className="text-[10px] font-semibold uppercase tracking-wider text-[var(--color-ink-muted)]">
        Daily budget
      </h3>
      {!editing ? (
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="block w-full rounded border border-transparent px-2 py-1 text-left hover:border-[var(--color-hairline)]"
        >
          {capDollars != null ? (
            <>
              <p className="text-sm text-[var(--color-ink)]">
                ${spentDollars.toFixed(2)}{' '}
                <span className="text-[var(--color-ink-muted)]">
                  / ${capDollars.toFixed(2)} cap
                </span>
              </p>
              <div
                className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-[var(--color-bg-subtle)]"
                aria-label={`${Math.round(fraction * 100)}% of daily cap used`}
              >
                <div
                  className="h-full rounded-full transition-all"
                  style={{
                    width: `${Math.min(100, fraction * 100)}%`,
                    background: meterColor,
                  }}
                />
              </div>
              {fraction >= 1 && (
                <p className="mt-1 text-[10px] text-[var(--color-danger)]">
                  Cap hit — turns are paused until midnight or until you
                  raise the cap.
                </p>
              )}
            </>
          ) : (
            <>
              <p className="text-sm text-[var(--color-ink)]">No cap</p>
              <p className="mt-0.5 text-xs text-[var(--color-ink-muted)]">
                Spent today: ${spentDollars.toFixed(2)}. Click to set a daily
                limit.
              </p>
            </>
          )}
        </button>
      ) : (
        <div className="flex items-center gap-2">
          <span className="text-sm text-[var(--color-ink-muted)]">$</span>
          <input
            type="text"
            inputMode="decimal"
            autoFocus
            value={valueDollars}
            onChange={(e) => setValueDollars(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void commit();
              if (e.key === 'Escape') {
                setEditing(false);
                setError(null);
                setValueDollars(
                  agent.daily_budget_cents != null
                    ? (agent.daily_budget_cents / 100).toFixed(2)
                    : '',
                );
              }
            }}
            placeholder="e.g. 5.00 (blank = no cap)"
            className="flex-1 rounded border border-[var(--color-hairline)] px-2 py-1 text-sm text-[var(--color-ink)]"
            disabled={saving}
          />
          <Button variant="primary" onClick={commit} disabled={saving}>
            {saving ? 'Saving…' : 'Set'}
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              setEditing(false);
              setError(null);
            }}
            disabled={saving}
          >
            Cancel
          </Button>
        </div>
      )}
      {error && (
        <p className="text-xs text-[var(--color-danger)]">{error}</p>
      )}
      <p className="text-[10px] text-[var(--color-ink-muted)]">
        Cap applies across every group this agent answers. Reversible
        for 5 minutes from the Audit page.
      </p>
    </div>
  );
}
