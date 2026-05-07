'use client';

import { AlertTriangle, ExternalLink, LifeBuoy } from 'lucide-react';

interface Props {
  error: Error;
}

/**
 * Shown when the dashboard cannot reach the local NanoClaw HTTP server.
 * The most common causes are: NanoClaw not running (launchd unloaded),
 * the host port collision lesson from the 2026-05-05 EADDRINUSE incident,
 * or a network hiccup mid-poll.
 *
 * Recovery flow (Phase 0 of the embedded recovery experience):
 * 1. Primary CTA: open the standalone Recovery Center at
 *    `~/Library/Application Support/Factotem/recovery.html` (installed via
 *    `bash scripts/install-recovery.sh`). The HTML works even when the
 *    dashboard is fully unreachable, polls /health to confirm recovery,
 *    and exposes copy-to-clipboard commands for the four-step
 *    Docker → OneCLI → NanoClaw → verify sequence.
 * 2. Secondary CTA: full runbook at `docs/OPERATIONS.md` for advanced
 *    incidents (Docker disk full, WhatsApp re-pair, credential rotation).
 *
 * Phase 1 will add a Tauri menu-bar app (`Factotem Doctor.app`) that owns
 * the same recovery flow with a one-click "Repair Stack" action; the
 * static HTML migrates into that app's bundled WebView at that point.
 */
export function ConnectionLossBanner({ error }: Props) {
  // Browser security blocks file:// from being loaded by an HTTP origin's
  // <a href> click, so we surface the path as text the operator can paste
  // into Spotlight or Finder. The Desktop shortcut installed by
  // scripts/install-recovery.sh is the friendlier discovery path.
  const recoveryPath =
    '~/Library/Application Support/Factotem/recovery.html';

  return (
    <div
      role="alert"
      className="flex items-start gap-3 rounded-2xl border border-red-200 bg-red-50 px-6 py-4 text-red-900 dark:border-red-900/40 dark:bg-red-950/30 dark:text-red-200"
    >
      <AlertTriangle
        className="mt-0.5 h-5 w-5 flex-shrink-0"
        aria-hidden="true"
      />
      <div className="flex-1 space-y-2">
        <p className="text-sm font-medium">
          Cannot reach NanoClaw on this machine
        </p>
        <p className="text-xs opacity-80">
          The dashboard is running but {`/health`} is unreachable. Check that
          the launchd service is loaded and the HTTP port is bound.
        </p>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 pt-1 text-xs">
          <span className="inline-flex items-center gap-1 font-medium">
            <LifeBuoy className="h-3.5 w-3.5" aria-hidden="true" />
            Recovery:
          </span>
          <span className="opacity-90">
            Double-click{' '}
            <strong>Factotem Recovery</strong> on your Desktop, or open{' '}
            <code className="rounded bg-red-100 px-1 py-0.5 font-mono text-[11px] dark:bg-red-900/40">
              {recoveryPath}
            </code>{' '}
            in your browser.
          </span>
          <a
            href="https://github.com/donkruger/benclaw/blob/main/docs/OPERATIONS.md#recovery"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 underline hover:no-underline"
          >
            Full runbook
            <ExternalLink className="h-3 w-3" aria-hidden="true" />
          </a>
        </div>
        <p className="text-[11px] opacity-70">
          If the recovery shortcut isn&apos;t on your Desktop, install it:{' '}
          <code className="rounded bg-red-100 px-1 py-0.5 font-mono text-[11px] dark:bg-red-900/40">
            bash scripts/install-recovery.sh
          </code>
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
