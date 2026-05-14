'use client';

import { ArrowUpRight, MessageCircle } from 'lucide-react';

import { Badge } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import type { Health } from '@/lib/nanoclaw';
import { formatRelativeTime } from '@/lib/format';
import { useElectronWizard } from '@/lib/electron';

interface Props {
  whatsapp: Health['whatsapp'];
}

export function WhatsAppCard({ whatsapp }: Props) {
  const authenticated = whatsapp.authenticated;
  // When the dashboard runs inside the NanoClaw Setup Electron app
  // (cli/claw-setup-gui), `wizard` is non-null and we deep-link the
  // "Not paired" state straight to the wizard's pairing step. Plain
  // browser visits get the original read-only card unchanged.
  const wizard = useElectronWizard();
  const showRepairLink = !!wizard && !authenticated;

  return (
    <Card>
      <div className="space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2">
            <MessageCircle
              className="h-5 w-5 text-[var(--color-accent)]"
              aria-hidden="true"
            />
            <h3 className="text-sm font-medium text-[var(--color-ink)]">
              WhatsApp
            </h3>
          </div>
          <Badge variant={authenticated ? 'success' : 'warning'}>
            {authenticated ? 'Authenticated' : 'Not paired'}
          </Badge>
        </div>

        <dl className="space-y-2 text-sm">
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-[var(--color-ink-muted)]">Last message</dt>
            <dd className="text-[var(--color-ink)]">
              {whatsapp.last_message_at ? (
                formatRelativeTime(whatsapp.last_message_at)
              ) : (
                <span className="text-[var(--color-ink-muted)]">—</span>
              )}
            </dd>
          </div>
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-[var(--color-ink-muted)]">Connection</dt>
            <dd className="text-[var(--color-ink)]">
              {authenticated ? 'connected' : 're-pair required'}
            </dd>
          </div>
        </dl>

        {showRepairLink && (
          <button
            type="button"
            onClick={() => {
              void wizard?.open('whatsapp');
            }}
            className="group inline-flex w-full items-center justify-between gap-2 rounded-md border border-[var(--color-hairline)] bg-[var(--color-bg-subtle)] px-3 py-2 text-xs font-medium text-[var(--color-ink)] transition-colors hover:bg-[var(--color-bg-elevated)]"
          >
            <span>Re-pair this device</span>
            <ArrowUpRight
              className="h-3.5 w-3.5 text-[var(--color-ink-muted)] transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5"
              aria-hidden="true"
            />
          </button>
        )}
      </div>
    </Card>
  );
}
