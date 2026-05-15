'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import {
  type Agent,
  type Provider,
  type ProviderRegistryEntry,
  getProviderRegistry,
  sandboxTestAgent,
  switchAgentProvider,
} from '@/lib/nanoclaw';

interface Props {
  open: boolean;
  onClose: () => void;
  agent: Agent;
  onSwitched: (committedProvider: Provider) => void;
}

type Screen = 'target' | 'diff' | 'test';

/**
 * ModelSwitchModal — the three-screen switch journey for an agent.
 *
 * A: Pick target provider.
 * B: Capability diff (side-by-side matrix showing gains / losses).
 * C: Optional sandboxed test message against the proposed provider.
 *
 * Commit hits POST /api/agents/:id/provider. Reversible for 5 min via
 * the audit log. See PROVIDER_PLAYBOOK § 4.3.2 and the Gemini blueprint
 * § 7.4 (Phase E.4).
 *
 * Apple-philosophy heuristics applied:
 *   - One primary action per screen (Show diff → Test or Switch → Commit).
 *   - Capability diff highlights gains in green / losses in amber so the
 *     loss-side is glanceable. Behavioural-warning banners surface when
 *     downstream features depend on the lost capability (e.g. open-DM
 *     requires caching).
 *   - The sandboxed test renders the reply inline rather than punting
 *     to a separate page — operators verify in 5 seconds without
 *     leaving the modal.
 */
export function ModelSwitchModal({
  open,
  onClose,
  agent,
  onSwitched,
}: Props) {
  const [registry, setRegistry] = useState<
    Record<string, ProviderRegistryEntry> | null
  >(null);
  const [registryError, setRegistryError] = useState<Error | null>(null);
  const [screen, setScreen] = useState<Screen>('target');
  const [targetProtocol, setTargetProtocol] = useState<string>(
    agent.provider.protocol,
  );
  const [targetModel, setTargetModel] = useState<string>(agent.provider.model);
  const [committing, setCommitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    void (async () => {
      try {
        const reg = await getProviderRegistry();
        setRegistry(reg);
      } catch (err) {
        setRegistryError(err as Error);
      }
    })();
  }, [open]);

  // Reset to first screen each time the modal opens.
  useEffect(() => {
    if (open) {
      setScreen('target');
      setTargetProtocol(agent.provider.protocol);
      setTargetModel(agent.provider.model);
      setError(null);
    }
  }, [open, agent.provider.protocol, agent.provider.model]);

  const targetEntry = registry?.[targetProtocol] ?? null;

  async function commit() {
    if (!targetEntry) return;
    setCommitting(true);
    setError(null);
    try {
      const next: Provider = {
        protocol: targetProtocol,
        model: targetModel,
        base_url: targetEntry.capabilities.local ? targetEntry.base_url : null,
        credential_id: targetEntry.onecli?.name ?? null,
      };
      await switchAgentProvider(agent.id, next);
      onSwitched(next);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setCommitting(false);
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title={`Switch ${agent.name}'s model`}>
      {registryError && (
        <p
          className="rounded border border-[var(--color-danger)] bg-[var(--color-danger-bg)] p-3 text-sm text-[var(--color-ink-on-danger)]"
        >
          Couldn&apos;t load the provider list: {registryError.message}
        </p>
      )}
      {!registry && !registryError && (
        <p className="text-sm text-[var(--color-ink-muted)]">Loading providers…</p>
      )}
      {registry && (
        <>
          {screen === 'target' && (
            <TargetScreen
              registry={registry}
              currentProtocol={agent.provider.protocol}
              currentModel={agent.provider.model}
              targetProtocol={targetProtocol}
              setTargetProtocol={(p) => {
                setTargetProtocol(p);
                setTargetModel(registry[p].default_model);
              }}
              targetModel={targetModel}
              setTargetModel={setTargetModel}
              onCancel={onClose}
              onContinue={() => setScreen('diff')}
            />
          )}
          {screen === 'diff' && (
            <DiffScreen
              currentEntry={registry[agent.provider.protocol]}
              currentModel={agent.provider.model}
              targetEntry={registry[targetProtocol]}
              targetModel={targetModel}
              error={error}
              committing={committing}
              onBack={() => setScreen('target')}
              onTest={() => setScreen('test')}
              onCommit={commit}
            />
          )}
          {screen === 'test' && (
            <TestScreen
              agent={agent}
              targetEntry={registry[targetProtocol]}
              targetModel={targetModel}
              onBack={() => setScreen('diff')}
              onCommit={commit}
              committing={committing}
              commitError={error}
            />
          )}
        </>
      )}
    </Dialog>
  );
}

// --- Screen A — Pick target provider --------------------------------------

function TargetScreen({
  registry,
  currentProtocol,
  currentModel,
  targetProtocol,
  setTargetProtocol,
  targetModel,
  setTargetModel,
  onCancel,
  onContinue,
}: {
  registry: Record<string, ProviderRegistryEntry>;
  currentProtocol: string;
  currentModel: string;
  targetProtocol: string;
  setTargetProtocol: (p: string) => void;
  targetModel: string;
  setTargetModel: (m: string) => void;
  onCancel: () => void;
  onContinue: () => void;
}) {
  const sameAsCurrent =
    targetProtocol === currentProtocol && targetModel === currentModel;
  const entries = useMemo(() => Object.entries(registry), [registry]);

  return (
    <div className="space-y-4">
      <p className="text-sm text-[var(--color-ink-muted)]">
        Currently:{' '}
        <span className="font-mono text-[var(--color-ink)]">
          {currentProtocol}/{currentModel}
        </span>
      </p>
      <div className="space-y-2">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--color-ink-muted)]">
          Switch to
        </p>
        <div className="space-y-2">
          {entries.map(([protocol, entry]) => (
            <label
              key={protocol}
              className="flex cursor-pointer items-start gap-3 rounded border border-[var(--color-hairline)] p-3 hover:bg-[var(--color-bg-subtle)]"
              style={
                targetProtocol === protocol
                  ? {
                      borderColor: 'var(--color-ink)',
                      background: 'var(--color-bg-subtle)',
                    }
                  : {}
              }
            >
              <input
                type="radio"
                name="target-provider"
                value={protocol}
                checked={targetProtocol === protocol}
                onChange={() => setTargetProtocol(protocol)}
                className="mt-1"
              />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-[var(--color-ink)]">
                    {entry.name}
                  </span>
                  {protocol === currentProtocol && <Badge>Current</Badge>}
                </div>
                <p className="text-xs text-[var(--color-ink-muted)]">
                  {entry.tagline}
                </p>
              </div>
            </label>
          ))}
        </div>
      </div>
      <div>
        <label className="block space-y-1">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--color-ink-muted)]">
            Model
          </span>
          <input
            type="text"
            value={targetModel}
            onChange={(e) => setTargetModel(e.target.value)}
            className="w-full rounded border border-[var(--color-hairline)] px-2 py-1 font-mono text-sm text-[var(--color-ink)]"
            spellCheck={false}
          />
          <span className="text-[11px] text-[var(--color-ink-muted)]">
            Defaults to {registry[targetProtocol]?.default_model}. Type a
            specific model name to override.
          </span>
        </label>
      </div>
      <div className="flex justify-end gap-2 pt-2">
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          variant="primary"
          onClick={onContinue}
          disabled={sameAsCurrent}
        >
          Show diff →
        </Button>
      </div>
    </div>
  );
}

// --- Screen B — Capability diff -------------------------------------------

function DiffScreen({
  currentEntry,
  currentModel,
  targetEntry,
  targetModel,
  error,
  committing,
  onBack,
  onTest,
  onCommit,
}: {
  currentEntry: ProviderRegistryEntry | undefined;
  currentModel: string;
  targetEntry: ProviderRegistryEntry;
  targetModel: string;
  error: string | null;
  committing: boolean;
  onBack: () => void;
  onTest: () => void;
  onCommit: () => void;
}) {
  if (!currentEntry) {
    return (
      <p className="text-sm text-[var(--color-ink-muted)]">
        Current provider not in the registry — switch will still work, but
        we can&apos;t show a side-by-side capability diff.
      </p>
    );
  }

  const rows: Array<{
    label: string;
    current: string;
    target: string;
    delta: 'gain' | 'loss' | 'same';
  }> = [
    capabilityRow('Tool use', currentEntry, targetEntry, (e) =>
      capitalise(e.capabilities.tool_use),
    ),
    capabilityRow('Vision', currentEntry, targetEntry, (e) =>
      e.capabilities.vision ? '✓' : '—',
    ),
    capabilityRow('Computer use', currentEntry, targetEntry, (e) =>
      e.capabilities.computer_use ? '✓' : '—',
    ),
    capabilityRow('Prompt caching', currentEntry, targetEntry, (e) =>
      e.capabilities.prompt_caching ? '✓' : '—',
    ),
    capabilityRow('Long context', currentEntry, targetEntry, (e) =>
      e.capabilities.long_context ? '✓' : '—',
    ),
    {
      label: 'Cost / day est.',
      current: currentEntry.cost_hint,
      target: targetEntry.cost_hint,
      delta: 'same',
    },
  ];

  const lostCaching =
    currentEntry.capabilities.prompt_caching &&
    !targetEntry.capabilities.prompt_caching;
  const lostComputerUse =
    currentEntry.capabilities.computer_use &&
    !targetEntry.capabilities.computer_use;

  return (
    <div className="space-y-4">
      <p className="text-sm text-[var(--color-ink-muted)]">
        Compare{' '}
        <span className="font-mono text-[var(--color-ink)]">
          {currentEntry.name} ({currentModel})
        </span>{' '}
        →{' '}
        <span className="font-mono text-[var(--color-ink)]">
          {targetEntry.name} ({targetModel})
        </span>
      </p>
      <div className="rounded border border-[var(--color-hairline)]">
        <table className="w-full text-sm">
          <thead className="bg-[var(--color-bg-subtle)] text-[10px] font-semibold uppercase tracking-wider text-[var(--color-ink-muted)]">
            <tr>
              <th className="px-3 py-2 text-left">Capability</th>
              <th className="px-3 py-2 text-left">{currentEntry.name}</th>
              <th className="px-3 py-2 text-left">{targetEntry.name}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.label} className="border-t border-[var(--color-hairline)]">
                <td className="px-3 py-2 text-[var(--color-ink-muted)]">
                  {r.label}
                </td>
                <td className="px-3 py-2 font-mono text-[var(--color-ink)]">
                  {r.current}
                </td>
                <td
                  className="px-3 py-2 font-mono"
                  style={{
                    color:
                      r.delta === 'gain'
                        ? 'var(--color-success)'
                        : r.delta === 'loss'
                          ? 'var(--color-warning)'
                          : 'var(--color-ink)',
                  }}
                >
                  {r.target}
                  {r.delta === 'gain' && (
                    <span className="ml-1 text-[10px]">← gained</span>
                  )}
                  {r.delta === 'loss' && (
                    <span className="ml-1 text-[10px]">← lost</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {lostCaching && (
        <p
          className="rounded border-l-2 border-[var(--color-warning)] bg-[var(--color-bg-subtle)] p-3 text-xs text-[var(--color-ink)]"
        >
          ⚠ Prompt caching is lost. If any of this agent&apos;s groups use
          open-DM mode, per-message cost will rise (~3× on a chatty group).
          Consider raising the daily budget cap.
        </p>
      )}
      {lostComputerUse && (
        <p
          className="rounded border-l-2 border-[var(--color-warning)] bg-[var(--color-bg-subtle)] p-3 text-xs text-[var(--color-ink)]"
        >
          ⚠ Computer-use tool is lost. Conversations that asked this agent
          to take screenshots / interact with a browser will fail on the
          target.
        </p>
      )}
      <p
        className="rounded border-l-2 border-[var(--color-success)] bg-[var(--color-bg-subtle)] p-3 text-xs text-[var(--color-ink)]"
      >
        ✓ Conversation history is preserved. The new container reads the
        same per-group memory and SQLite session.
      </p>

      {error && (
        <p
          className="rounded border border-[var(--color-danger)] bg-[var(--color-danger-bg)] p-3 text-sm text-[var(--color-ink-on-danger)]"
        >
          {error}
        </p>
      )}

      <div className="flex justify-end gap-2 pt-2">
        <Button variant="ghost" onClick={onBack} disabled={committing}>
          ← Back
        </Button>
        <Button variant="ghost" onClick={onTest} disabled={committing}>
          Send a test message first
        </Button>
        <Button variant="primary" onClick={onCommit} disabled={committing}>
          {committing ? 'Switching…' : 'Switch →'}
        </Button>
      </div>
    </div>
  );
}

function capabilityRow(
  label: string,
  current: ProviderRegistryEntry,
  target: ProviderRegistryEntry,
  pick: (e: ProviderRegistryEntry) => string,
): { label: string; current: string; target: string; delta: 'gain' | 'loss' | 'same' } {
  const c = pick(current);
  const t = pick(target);
  let delta: 'gain' | 'loss' | 'same' = 'same';
  if (c === '—' && t === '✓') delta = 'gain';
  else if (c === '✓' && t === '—') delta = 'loss';
  return { label, current: c, target: t, delta };
}

function capitalise(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

// --- Screen C — Sandboxed test --------------------------------------------

function TestScreen({
  agent,
  targetEntry,
  targetModel,
  onBack,
  onCommit,
  committing,
  commitError,
}: {
  agent: Agent;
  targetEntry: ProviderRegistryEntry;
  targetModel: string;
  onBack: () => void;
  onCommit: () => void;
  committing: boolean;
  commitError: string | null;
}) {
  const [prompt, setPrompt] = useState('What time is it in Cape Town?');
  const [reply, setReply] = useState<string | null>(null);
  const [stub, setStub] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testError, setTestError] = useState<string | null>(null);

  const sendTest = useCallback(async () => {
    if (!prompt.trim()) return;
    setTesting(true);
    setReply(null);
    setStub(false);
    setTestError(null);
    try {
      const r = await sandboxTestAgent(agent.id, {
        protocol: targetEntry.wire_protocol === 'anthropic' ? 'anthropic' : 'gemini',
        model: targetModel,
        prompt,
      });
      setReply(r.reply);
      setStub(!!r.stub);
    } catch (err) {
      setTestError((err as Error).message);
    } finally {
      setTesting(false);
    }
  }, [agent.id, prompt, targetEntry.wire_protocol, targetModel]);

  return (
    <div className="space-y-4">
      <p className="text-sm text-[var(--color-ink-muted)]">
        Send a test message against{' '}
        <span className="font-mono text-[var(--color-ink)]">
          {targetEntry.name} / {targetModel}
        </span>{' '}
        without affecting this agent&apos;s live groups.
      </p>
      <label className="block space-y-1">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--color-ink-muted)]">
          Test prompt
        </span>
        <input
          type="text"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          className="w-full rounded border border-[var(--color-hairline)] px-2 py-1 text-sm text-[var(--color-ink)]"
        />
      </label>
      <div className="flex justify-end gap-2">
        <Button variant="primary" onClick={sendTest} disabled={testing || !prompt.trim()}>
          {testing ? 'Sending…' : 'Send test'}
        </Button>
      </div>

      {testError && (
        <p
          className="rounded border border-[var(--color-danger)] bg-[var(--color-danger-bg)] p-3 text-sm text-[var(--color-ink-on-danger)]"
        >
          {testError}
        </p>
      )}

      {reply !== null && (
        <div className="space-y-2">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--color-ink-muted)]">
            Reply
          </p>
          <div className="rounded border border-[var(--color-hairline)] bg-[var(--color-bg-subtle)] p-3 text-sm text-[var(--color-ink)]">
            {reply}
          </div>
          {stub && (
            <p className="text-xs text-[var(--color-ink-muted)]">
              Note: the sandboxed-test backend is a stub in this build. The
              switch itself works; real test execution against the
              proposed provider lands in the streaming follow-up PR.
            </p>
          )}
        </div>
      )}

      {commitError && (
        <p
          className="rounded border border-[var(--color-danger)] bg-[var(--color-danger-bg)] p-3 text-sm text-[var(--color-ink-on-danger)]"
        >
          {commitError}
        </p>
      )}

      <div className="flex justify-end gap-2 pt-2">
        <Button variant="ghost" onClick={onBack} disabled={committing}>
          ← Back
        </Button>
        <Button variant="primary" onClick={onCommit} disabled={committing}>
          {committing ? 'Switching…' : 'Looks good — switch'}
        </Button>
      </div>
    </div>
  );
}
