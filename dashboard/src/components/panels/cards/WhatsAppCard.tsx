'use client';

import { MessageCircle } from 'lucide-react';

import { Badge } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import type { Health } from '@/lib/nanoclaw';
import { formatRelativeTime } from '@/lib/format';

interface Props {
  whatsapp: Health['whatsapp'];
}

export function WhatsAppCard({ whatsapp }: Props) {
  const authenticated = whatsapp.authenticated;

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
      </div>
    </Card>
  );
}
