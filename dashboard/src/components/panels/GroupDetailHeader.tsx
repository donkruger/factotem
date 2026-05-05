'use client';

import { Badge } from '@/components/ui/Badge';
import {
  type Group,
  isGroupDeleted,
  isGroupDisabled,
} from '@/lib/nanoclaw';
import { formatRelativeTime } from '@/lib/format';

interface GroupDetailHeaderProps {
  group: Group;
}

function channelOf(folder: string): string {
  const idx = folder.indexOf('_');
  if (idx <= 0) return '—';
  const prefix = folder.slice(0, idx).toLowerCase();
  switch (prefix) {
    case 'whatsapp':
      return 'WhatsApp';
    case 'telegram':
      return 'Telegram';
    case 'slack':
      return 'Slack';
    case 'discord':
      return 'Discord';
    case 'gmail':
      return 'Gmail';
    case 'signal':
      return 'Signal';
    case 'emacs':
      return 'Emacs';
    default:
      return prefix.charAt(0).toUpperCase() + prefix.slice(1);
  }
}

function profileOf(group: Group): string {
  const cfg = group.container_config as Record<string, unknown> | null;
  const v = cfg?.['agentProfile'];
  return typeof v === 'string' && v.length > 0 ? v : 'main';
}

/**
 * Identity card for the group detail page. Shows the group's name,
 * folder + JID for copy/paste, and a row of badges that mirror the
 * routing-relevant flags the orchestrator uses (main, disabled,
 * soft-deleted, channel, profile). `added_at` becomes a relative time
 * — entries that pre-date the metadata column simply hide the line.
 */
export function GroupDetailHeader({ group }: GroupDetailHeaderProps) {
  const disabled = isGroupDisabled(group);
  const deleted = isGroupDeleted(group);
  const channel = channelOf(group.folder);
  const profile = profileOf(group);

  return (
    <div className="rounded-2xl border border-[var(--color-hairline)] bg-[var(--color-bg)] p-6">
      <div className="space-y-3">
        <div className="space-y-1">
          <h2 className="text-2xl font-medium tracking-tight text-[var(--color-ink)]">
            {group.name || group.folder}
          </h2>
          <div className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-xs text-[var(--color-ink-muted)]">
            <span>folder · {group.folder}</span>
            <span>jid · {group.jid}</span>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="neutral">Profile · {profile}</Badge>
          <Badge variant="neutral">Channel · {channel}</Badge>
          {group.is_main && <Badge variant="neutral">Main</Badge>}
          {disabled && <Badge variant="warning">Disabled</Badge>}
          {deleted && <Badge variant="error">Soft-deleted</Badge>}
          {group.requires_trigger && (
            <Badge variant="neutral">Trigger required</Badge>
          )}
        </div>

        {group.added_at && (
          <p className="text-xs text-[var(--color-ink-muted)]">
            Added {formatRelativeTime(group.added_at)}
          </p>
        )}
      </div>
    </div>
  );
}
