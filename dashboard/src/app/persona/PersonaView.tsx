'use client';

import { useCallback, useState } from 'react';

import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
} from '@/components/ui/Table';
import { ConnectionLossBanner } from '@/components/panels/ConnectionLossBanner';
import { usePoll } from '@/hooks/usePoll';
import { type Persona, getPersona } from '@/lib/nanoclaw';

const POLL_INTERVAL_MS = 10_000;

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const onClick = useCallback(() => {
    navigator.clipboard.writeText(text).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => {
        // Clipboard write can fail under HTTP (non-secure context) — degrade
        // gracefully. Operator can still select-and-copy from the rendered
        // <code> block.
      },
    );
  }, [text]);
  return (
    <Button
      type="button"
      variant="ghost"
      onClick={onClick}
      aria-label={`Copy ${label}`}
    >
      {copied ? 'Copied' : 'Copy'}
    </Button>
  );
}

/**
 * Read-only Persona view. Polls /api/persona every 10s. Renders:
 *   - Global ASSISTANT_NAME + DEFAULT_TRIGGER (from .env via src/config.ts).
 *   - Per-group rows with trigger_pattern + is_main flag.
 *   - Copy-pasteable commands for changing the persona (.env line + the
 *     `setup --step register` invocation).
 *
 * No mutating endpoints — operators edit `.env` and run the register
 * command directly. The page surfaces what's running and how to change it.
 */
export function PersonaView() {
  const fetchPersona = useCallback(() => getPersona(), []);
  const { data, error, loading } = usePoll<Persona>(
    fetchPersona,
    POLL_INTERVAL_MS,
  );

  const envLine = data ? `ASSISTANT_NAME="${data.assistant_name}"` : '';
  const registerExample = data
    ? `npx tsx setup/index.ts --step register \\\n  --jid '<group-jid>' --name '<group-name>' \\\n  --folder main --channel whatsapp \\\n  --trigger '@${data.assistant_name}' --is-main \\\n  --assistant-name '${data.assistant_name}'`
    : '';

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <h1 className="text-3xl font-medium tracking-tight text-[var(--color-ink)]">
          Persona
        </h1>
        <p className="text-sm text-[var(--color-ink-muted)]">
          The agent identity this deployment runs as. Global name comes from{' '}
          <code className="rounded bg-[var(--color-bg-subtle)] px-1.5 py-0.5 font-mono text-xs text-[var(--color-ink)]">
            ASSISTANT_NAME
          </code>{' '}
          in <code className="font-mono text-xs">.env</code>; per-group{' '}
          triggers live in{' '}
          <code className="font-mono text-xs">registered_groups</code>.
        </p>
      </div>

      {error && <ConnectionLossBanner error={error} />}

      {loading && !data && (
        <Card>
          <p className="text-sm text-[var(--color-ink-muted)]">
            Loading persona…
          </p>
        </Card>
      )}

      {data && (
        <>
          <Card>
            <div className="space-y-3">
              <div className="flex flex-wrap items-baseline gap-3">
                <span className="text-xs uppercase tracking-wide text-[var(--color-ink-muted)]">
                  Assistant name
                </span>
                <span className="font-mono text-xl font-medium text-[var(--color-ink)]">
                  {data.assistant_name}
                </span>
                <Badge variant="neutral">
                  default trigger {data.default_trigger}
                </Badge>
              </div>
              <p className="text-sm text-[var(--color-ink-muted)]">
                To change the global persona, edit{' '}
                <code className="font-mono text-xs">.env</code> on the host
                and re-register the main group with the new trigger.
              </p>
            </div>
          </Card>

          <Card>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-lg font-medium text-[var(--color-ink)]">
                Per-group triggers
              </h2>
              <span className="text-xs text-[var(--color-ink-muted)]">
                {data.groups.length} registered
              </span>
            </div>
            {data.groups.length === 0 ? (
              <p className="text-sm text-[var(--color-ink-muted)]">
                No groups registered yet. Run{' '}
                <code className="font-mono text-xs">npm run claw-setup</code>{' '}
                to register your first.
              </p>
            ) : (
              <Table>
                <TableHead>
                  <TableRow>
                    <TableCell header>Name</TableCell>
                    <TableCell header>Folder</TableCell>
                    <TableCell header>Trigger</TableCell>
                    <TableCell header>Role</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {data.groups.map((g) => (
                    <TableRow key={g.jid}>
                      <TableCell>{g.name}</TableCell>
                      <TableCell>
                        <code className="font-mono text-xs text-[var(--color-ink-muted)]">
                          {g.folder}
                        </code>
                      </TableCell>
                      <TableCell>
                        <code className="font-mono text-xs text-[var(--color-ink)]">
                          {g.trigger || '—'}
                        </code>
                      </TableCell>
                      <TableCell>
                        {g.is_main ? (
                          <Badge variant="success">main</Badge>
                        ) : (
                          <Badge variant="neutral">subgroup</Badge>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </Card>

          <Card>
            <div className="space-y-4">
              <h2 className="text-lg font-medium text-[var(--color-ink)]">
                How to change persona
              </h2>
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-xs uppercase tracking-wide text-[var(--color-ink-muted)]">
                    1. Update .env
                  </span>
                  <CopyButton text={envLine} label="env line" />
                </div>
                <pre className="overflow-x-auto rounded-lg border border-[var(--color-hairline)] bg-[var(--color-bg-subtle)] p-3 font-mono text-xs text-[var(--color-ink)]">
                  {envLine}
                </pre>
              </div>
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-xs uppercase tracking-wide text-[var(--color-ink-muted)]">
                    2. Re-register the main group
                  </span>
                  <CopyButton
                    text={registerExample}
                    label="register command"
                  />
                </div>
                <pre className="overflow-x-auto rounded-lg border border-[var(--color-hairline)] bg-[var(--color-bg-subtle)] p-3 font-mono text-xs text-[var(--color-ink)]">
                  {registerExample}
                </pre>
                <p className="text-xs text-[var(--color-ink-muted)]">
                  The register command rewrites{' '}
                  <code className="font-mono">.env</code>, renames{' '}
                  <code className="font-mono">groups/*/CLAUDE.md</code>, and
                  updates the trigger in SQLite. Restart the orchestrator
                  after to pick up the new config.
                </p>
              </div>
            </div>
          </Card>
        </>
      )}
    </div>
  );
}
