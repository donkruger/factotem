/**
 * Display formatting helpers used by dashboard panels. Keep these pure and
 * dependency-free so they can be unit-tested in isolation.
 */

const ONE_MINUTE = 60_000;
const ONE_HOUR = 60 * ONE_MINUTE;
const ONE_DAY = 24 * ONE_HOUR;

/**
 * Returns a relative time phrase for ISO timestamps in the recent past.
 * Falls back to an absolute locale date for entries older than ~7 days.
 */
export function formatRelativeTime(iso: string): string {
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return iso;
  const delta = Date.now() - ts;
  if (delta < 0) return 'in the future';
  if (delta < ONE_MINUTE) return 'just now';
  if (delta < ONE_HOUR) {
    const mins = Math.floor(delta / ONE_MINUTE);
    return `${mins} min ago`;
  }
  if (delta < ONE_DAY) {
    const hours = Math.floor(delta / ONE_HOUR);
    return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  }
  if (delta < 2 * ONE_DAY) return 'yesterday';
  if (delta < 7 * ONE_DAY) {
    const days = Math.floor(delta / ONE_DAY);
    return `${days} days ago`;
  }
  return new Date(ts).toLocaleDateString();
}

/** Format integer cents as a USD string. */
export function formatCostCents(cents: number): string {
  if (!Number.isFinite(cents)) return '$0.00';
  const dollars = cents / 100;
  return `$${dollars.toFixed(2)}`;
}

/**
 * Compact token count: 1_200_000 → "1.2M", 84_000 → "84k", 512 → "512".
 * Used by the usage-mode cost panels (subscription/oauth deployments where
 * per-token dollar costs aren't meaningful — see `isUsageMode`).
 */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n < 1_000) return String(Math.round(n));
  if (n < 1_000_000) {
    const k = n / 1_000;
    // 1 decimal under 100k (1.2k, 84.0k → 84k), whole numbers above.
    return `${k < 100 ? trimZero(k.toFixed(1)) : Math.round(k)}k`;
  }
  const m = n / 1_000_000;
  return `${m < 100 ? trimZero(m.toFixed(1)) : Math.round(m)}M`;
}

/** Drop a trailing ".0" so "84.0" → "84" but "1.2" stays. */
function trimZero(s: string): string {
  return s.endsWith('.0') ? s.slice(0, -2) : s;
}

/** Format a millisecond duration with progressive units. */
export function formatDurationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0ms';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < ONE_MINUTE) {
    const seconds = ms / 1000;
    return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  }
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  return `${hours}h ${String(remMinutes).padStart(2, '0')}m`;
}
