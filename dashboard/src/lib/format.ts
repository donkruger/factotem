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
