'use client';

import { useCallback } from 'react';

import { Card } from '@/components/ui/Card';
import { usePoll } from '@/hooks/usePoll';
import { getHealth, type Health } from '@/lib/nanoclaw';

import { ConnectionLossBanner } from './ConnectionLossBanner';
import { MachineIdentityStrip } from './MachineIdentityStrip';
import { DockerCard } from './cards/DockerCard';
import { NanoClawCard } from './cards/NanoClawCard';
import { OneCLICard } from './cards/OneCLICard';
import { WhatsAppCard } from './cards/WhatsAppCard';

/**
 * Server Health is the dashboard's default landing panel. Polls
 * `/health` every 5s and renders one card per subsystem with a top
 * machine-identity strip.
 *
 * Federation-ready: the strip exposes hostname + region + Tailscale IP,
 * so v2's aggregator can layer this same panel one-per-machine.
 *
 * T-1778240000000 (Phase 2 of Factotem Dashboard v1 epic).
 */
export function ServerHealth() {
  const fetchHealth = useCallback(() => getHealth(), []);
  const { data, error, loading } = usePoll<Health>(fetchHealth, 5000);

  // The first poll is in flight and there's no prior data — show a quiet
  // placeholder. Subsequent transient errors keep the last known data
  // visible while surfacing the banner.
  const isInitialLoad = loading && !data;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-medium tracking-tight text-[var(--color-ink)]">
          Server Health
        </h1>
        <p className="mt-2 text-sm text-[var(--color-ink-muted)]">
          Live state of this NanoClaw deployment. Polled every 5 seconds.
        </p>
      </div>

      {error && <ConnectionLossBanner error={error} />}

      {isInitialLoad && (
        <Card>
          <p className="text-sm text-[var(--color-ink-muted)]">
            Loading health snapshot…
          </p>
        </Card>
      )}

      {data && (
        <>
          <MachineIdentityStrip machine={data.machine} />

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <NanoClawCard nanoclaw={data.nanoclaw} />
            <DockerCard docker={data.docker} />
            <OneCLICard onecli={data.onecli} />
            <WhatsAppCard whatsapp={data.whatsapp} />
          </div>
        </>
      )}
    </div>
  );
}
