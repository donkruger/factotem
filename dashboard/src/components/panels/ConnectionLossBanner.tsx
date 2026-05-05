'use client';

import { AlertTriangle, ExternalLink } from 'lucide-react';

interface Props {
  error: Error;
}

/**
 * Shown when the dashboard cannot reach the local NanoClaw HTTP server.
 * The most common causes are: NanoClaw not running (launchd unloaded),
 * the host port collision lesson from the 2026-05-05 EADDRINUSE incident,
 * or a network hiccup mid-poll.
 *
 * Links to the recovery procedure in `nanoclaw/docs/OPERATIONS.md` so
 * the operator can self-recover without leaving the dashboard.
 */
export function ConnectionLossBanner({ error }: Props) {
  return (
    <div
      role="alert"
      className="flex items-start gap-3 rounded-2xl border border-red-200 bg-red-50 px-6 py-4 text-red-900 dark:border-red-900/40 dark:bg-red-950/30 dark:text-red-200"
    >
      <AlertTriangle
        className="mt-0.5 h-5 w-5 flex-shrink-0"
        aria-hidden="true"
      />
      <div className="flex-1 space-y-1">
        <p className="text-sm font-medium">
          Cannot reach NanoClaw on this machine
        </p>
        <p className="text-xs opacity-80">
          The dashboard is running but {`/health`} is unreachable. Check that
          the launchd service is loaded and the HTTP port is bound.
        </p>
        <p className="text-xs">
          <a
            href="https://github.com/donkruger/benclaw/blob/main/docs/OPERATIONS.md#recovery"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 underline hover:no-underline"
          >
            View recovery procedure
            <ExternalLink className="h-3 w-3" aria-hidden="true" />
          </a>
        </p>
        <details className="mt-2 text-xs">
          <summary className="cursor-pointer opacity-70 hover:opacity-100">
            Error detail
          </summary>
          <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-words font-mono text-[10px] opacity-70">
            {error.message}
          </pre>
        </details>
      </div>
    </div>
  );
}
