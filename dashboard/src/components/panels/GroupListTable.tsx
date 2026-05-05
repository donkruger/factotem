'use client';

import { useMemo, useState } from 'react';
import { ChevronRight, Search } from 'lucide-react';

import { Badge } from '@/components/ui/Badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
} from '@/components/ui/Table';
import {
  type Group,
  isGroupDeleted,
  isGroupDisabled,
} from '@/lib/nanoclaw';
import { formatRelativeTime } from '@/lib/format';

interface GroupListTableProps {
  groups: Group[];
  /** Called when a row is clicked. Receives the group's JID. */
  onSelect: (jid: string) => void;
}

/**
 * Strip the verbose suffix from Anthropic model IDs so they fit a column.
 * `claude-haiku-4-5-20251001` → `haiku-4-5`. Matches the helper used in
 * ActivityRow / ActivityFilters.
 */
function shortenModel(m: string | null | undefined): string {
  if (!m) return 'default';
  return m.replace(/^claude-/, '').replace(/-\d{8}$/, '');
}

/**
 * Derive the channel from the folder prefix. A group folder is
 * `{channel}_{name}` (e.g. `whatsapp_main`, `telegram_finance`); the
 * orchestrator's group registration enforces the prefix.
 */
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

function modelOf(group: Group): string {
  const cfg = group.container_config as Record<string, unknown> | null;
  const v = cfg?.['model'];
  return typeof v === 'string' && v.length > 0 ? v : 'default';
}

/**
 * Read a useful "last active" timestamp off the group. We don't have a
 * dedicated last_active column on /api/groups so this falls back to
 * added_at; the detail view layers in real activity from /api/turns.
 */
function lastActiveOf(group: Group): string | null {
  const cfg = group.container_config as Record<string, unknown> | null;
  const candidates = ['last_message_at', 'last_active_at', 'updated_at'];
  for (const key of candidates) {
    const v = cfg?.[key];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return group.added_at ?? null;
}

/**
 * Read all distinct channels present in the input list. Used to populate
 * the channel filter dropdown — we don't hardcode the channel list so
 * new channel skills surface automatically.
 */
function uniqueChannels(groups: Group[]): string[] {
  const set = new Set<string>();
  for (const g of groups) set.add(channelOf(g.folder));
  return Array.from(set)
    .filter((c) => c !== '—')
    .sort();
}

function uniqueProfiles(groups: Group[]): string[] {
  const set = new Set<string>();
  for (const g of groups) set.add(profileOf(g));
  return Array.from(set).sort();
}

export function GroupListTable({ groups, onSelect }: GroupListTableProps) {
  const [query, setQuery] = useState('');
  const [channelFilter, setChannelFilter] = useState('');
  const [profileFilter, setProfileFilter] = useState('');
  const [showDeleted, setShowDeleted] = useState(false);

  const channels = useMemo(() => uniqueChannels(groups), [groups]);
  const profiles = useMemo(() => uniqueProfiles(groups), [groups]);

  const deletedCount = useMemo(
    () => groups.filter((g) => isGroupDeleted(g)).length,
    [groups],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return groups.filter((g) => {
      if (!showDeleted && isGroupDeleted(g)) return false;
      if (channelFilter && channelOf(g.folder) !== channelFilter) return false;
      if (profileFilter && profileOf(g) !== profileFilter) return false;
      if (q) {
        const hay = `${g.name ?? ''} ${g.folder ?? ''} ${g.jid ?? ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [groups, query, channelFilter, profileFilter, showDeleted]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-[16rem] flex-1">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--color-ink-muted)]"
            aria-hidden="true"
          />
          <input
            type="search"
            placeholder="Search by name, folder, or JID…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="w-full rounded-xl border border-[var(--color-hairline)] bg-[var(--color-bg)] py-2.5 pl-10 pr-4 text-sm text-[var(--color-ink)] placeholder:text-[var(--color-ink-muted)] focus:border-[var(--color-ink)] focus:outline-none"
          />
        </div>

        <div className="flex items-center gap-2">
          <label className="text-xs uppercase tracking-wider text-[var(--color-ink-muted)]">
            Channel
          </label>
          <select
            value={channelFilter}
            onChange={(e) => setChannelFilter(e.target.value)}
            className="rounded-pill border border-[var(--color-hairline)] bg-[var(--color-bg)] px-3 py-1.5 text-sm text-[var(--color-ink)] focus:border-[var(--color-ink)] focus:outline-none"
          >
            <option value="">All channels</option>
            {channels.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>

        <div className="flex items-center gap-2">
          <label className="text-xs uppercase tracking-wider text-[var(--color-ink-muted)]">
            Profile
          </label>
          <select
            value={profileFilter}
            onChange={(e) => setProfileFilter(e.target.value)}
            className="rounded-pill border border-[var(--color-hairline)] bg-[var(--color-bg)] px-3 py-1.5 text-sm text-[var(--color-ink)] focus:border-[var(--color-ink)] focus:outline-none"
          >
            <option value="">All profiles</option>
            {profiles.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </div>

        {deletedCount > 0 && (
          <button
            type="button"
            onClick={() => setShowDeleted((v) => !v)}
            className="inline-flex items-center gap-1 rounded-pill border border-[var(--color-hairline)] px-3 py-1.5 text-xs text-[var(--color-ink-muted)] transition-colors hover:bg-[var(--color-bg-subtle)] hover:text-[var(--color-ink)]"
          >
            {showDeleted
              ? `Hide ${deletedCount} deleted`
              : `Show ${deletedCount} deleted`}
          </button>
        )}
      </div>

      <Table>
        <TableHead>
          <TableRow>
            <TableCell header>Name</TableCell>
            <TableCell header>Channel</TableCell>
            <TableCell header>Profile</TableCell>
            <TableCell header>Model</TableCell>
            <TableCell header>Status</TableCell>
            <TableCell header>Last Active</TableCell>
            <TableCell header>
              <span className="sr-only">Actions</span>
            </TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {filtered.length === 0 && (
            <TableRow>
              <TableCell
                colSpan={7}
                className="text-center text-sm text-[var(--color-ink-muted)]"
              >
                No groups match the current filters.
              </TableCell>
            </TableRow>
          )}
          {filtered.map((g) => {
            const disabled = isGroupDisabled(g);
            const deleted = isGroupDeleted(g);
            const lastActive = lastActiveOf(g);
            return (
              <TableRow
                key={g.jid}
                onClick={() => onSelect(g.jid)}
                className="cursor-pointer"
              >
                <TableCell>
                  <div className="flex flex-col">
                    <span className="text-sm font-medium text-[var(--color-ink)]">
                      {g.name || g.folder}
                    </span>
                    <span className="font-mono text-[10px] text-[var(--color-ink-muted)]">
                      {g.folder}
                    </span>
                  </div>
                </TableCell>
                <TableCell>
                  <span className="text-xs text-[var(--color-ink)]">
                    {channelOf(g.folder)}
                  </span>
                </TableCell>
                <TableCell>
                  <span className="font-mono text-xs text-[var(--color-ink-muted)]">
                    {profileOf(g)}
                  </span>
                </TableCell>
                <TableCell>
                  <span className="font-mono text-xs text-[var(--color-ink-muted)]">
                    {shortenModel(modelOf(g))}
                  </span>
                </TableCell>
                <TableCell>
                  <div className="flex flex-wrap gap-1">
                    {g.is_main && <Badge variant="neutral">Main</Badge>}
                    {disabled && <Badge variant="warning">Disabled</Badge>}
                    {deleted && <Badge variant="error">Deleted</Badge>}
                    {!disabled && !deleted && !g.is_main && (
                      <span className="text-xs text-[var(--color-ink-muted)]">
                        Active
                      </span>
                    )}
                  </div>
                </TableCell>
                <TableCell>
                  <span className="text-xs text-[var(--color-ink-muted)]">
                    {lastActive ? formatRelativeTime(lastActive) : '—'}
                  </span>
                </TableCell>
                <TableCell className="text-right">
                  <ChevronRight
                    className="ml-auto h-4 w-4 text-[var(--color-ink-muted)]"
                    aria-hidden="true"
                  />
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
