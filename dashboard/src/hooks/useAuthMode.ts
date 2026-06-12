'use client';

import { useCallback } from 'react';

import { usePoll } from '@/hooks/usePoll';
import { type Health, getHealth, isUsageMode } from '@/lib/nanoclaw';

/**
 * Shared accessor for the deployment's Anthropic auth mode. Wraps the
 * /health poll (60s — auth mode changes at most on a manual rotation) and
 * derives `usageMode`, which gates the dashboard's cost↔usage pivot.
 *
 * `usageMode` defaults to `false` until /health resolves, so the dollar
 * view is the optimistic default and the usage view only appears once we
 * positively confirm a subscription/oauth token. (Erring this way means a
 * brief flash of the dollar layout on slow loads rather than wrongly
 * hiding cost data from a real api-key deployment.)
 */
export function useAuthMode(): {
  authMode: string | null;
  usageMode: boolean;
  loading: boolean;
} {
  const fetchHealth = useCallback(() => getHealth(), []);
  const { data, loading } = usePoll<Health>(fetchHealth, 60_000);
  const authMode = data?.onecli.auth_mode ?? null;
  return { authMode, usageMode: isUsageMode(authMode), loading };
}
