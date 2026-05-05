'use client';

import { Globe, Network, HardDrive } from 'lucide-react';

import type { MachineIdentity } from '@/lib/nanoclaw';

interface Props {
  machine: MachineIdentity & { tailscale_ip: string | null };
}

/**
 * Top-of-page strip showing this NanoClaw deployment's identity.
 * Federation-friendly from day one — every machine in v2 will display the
 * same strip with its own values, so the operator can tell at a glance
 * which machine they're looking at.
 */
export function MachineIdentityStrip({ machine }: Props) {
  return (
    <div className="rounded-2xl border border-[var(--color-hairline)] bg-[var(--color-bg-elevated)] px-6 py-4">
      <div className="flex flex-wrap items-center gap-x-8 gap-y-2 text-sm">
        <div className="flex items-center gap-2">
          <Globe
            className="h-4 w-4 text-[var(--color-ink-muted)]"
            aria-hidden="true"
          />
          <span className="text-xs uppercase tracking-wider text-[var(--color-ink-muted)]">
            Region
          </span>
          <span className="font-medium text-[var(--color-ink)]">
            {machine.region}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <HardDrive
            className="h-4 w-4 text-[var(--color-ink-muted)]"
            aria-hidden="true"
          />
          <span className="text-xs uppercase tracking-wider text-[var(--color-ink-muted)]">
            Hostname
          </span>
          <span className="font-medium text-[var(--color-ink)]">
            {machine.hostname || 'unknown'}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <Network
            className="h-4 w-4 text-[var(--color-ink-muted)]"
            aria-hidden="true"
          />
          <span className="text-xs uppercase tracking-wider text-[var(--color-ink-muted)]">
            Tailscale
          </span>
          <span className="font-mono text-xs text-[var(--color-ink)]">
            {machine.tailscale_ip ?? (
              <span className="text-[var(--color-ink-muted)]">—</span>
            )}
          </span>
        </div>
      </div>
    </div>
  );
}
