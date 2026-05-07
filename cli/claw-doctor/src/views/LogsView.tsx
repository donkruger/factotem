/**
 * NanoClaw logs window — M1.4 of Phase 1.
 *
 * Read-only tail viewer for `nanoclaw.log` (resolved by the Rust side
 * via the launchd plist or the known `~/Documents/.../logs/` fallback).
 * Auto-refreshes every 3 seconds while live mode is on; the operator
 * can toggle off to read a stable snapshot, change line counts, or
 * paste the contents into a runbook.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { getLogPath, tailLog } from '../lib/tauri';

const LINES_OPTIONS = [100, 250, 500, 1000];
const REFRESH_INTERVAL_MS = 3_000;

export function LogsView() {
  const [logPath, setLogPath] = useState<string | null>(null);
  const [pathError, setPathError] = useState<string | null>(null);
  const [lines, setLines] = useState<number>(250);
  const [content, setContent] = useState<string>('');
  const [contentError, setContentError] = useState<string | null>(null);
  const [live, setLive] = useState<boolean>(true);
  const [lastFetchedAt, setLastFetchedAt] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const preRef = useRef<HTMLPreElement>(null);
  const stickToBottomRef = useRef<boolean>(true);

  // Resolve the log path once on mount.
  useEffect(() => {
    let cancelled = false;
    getLogPath()
      .then((p) => {
        if (!cancelled) setLogPath(p);
      })
      .catch((e) => {
        if (!cancelled) setPathError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const refresh = useCallback(async () => {
    setBusy(true);
    setContentError(null);
    try {
      const text = await tailLog(lines);
      setContent(text);
      setLastFetchedAt(Date.now());
    } catch (e) {
      setContentError(String(e));
    } finally {
      setBusy(false);
    }
  }, [lines]);

  // Initial fetch + auto-refresh poll.
  useEffect(() => {
    refresh();
    if (!live) return;
    const id = window.setInterval(refresh, REFRESH_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [live, refresh]);

  // Keep the view scrolled to the latest line when in stick-to-bottom mode.
  useEffect(() => {
    const pre = preRef.current;
    if (!pre) return;
    if (stickToBottomRef.current) {
      pre.scrollTop = pre.scrollHeight;
    }
  }, [content]);

  // If the operator scrolls up, stop auto-following the tail. If they
  // scroll back to within 16px of the bottom, resume following.
  const onScroll = () => {
    const pre = preRef.current;
    if (!pre) return;
    const distFromBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight;
    stickToBottomRef.current = distFromBottom < 16;
  };

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(content);
    } catch (e) {
      // Permission could fail in WebView; fallback to selecting all.
      console.warn('clipboard write failed', e);
    }
  };

  return (
    <div className="logs-shell">
      <Styles />
      <header>
        <span className="brand">
          <span className="dot" /> Factotem Doctor
        </span>
        <h1>NanoClaw logs</h1>
        <p className="lede">
          Tail of the orchestrator&apos;s stdout log. Auto-refresh every
          {' '}
          <code>{REFRESH_INTERVAL_MS / 1000}s</code> when Live is on.
          Scroll up to pause auto-follow; scroll to the bottom to resume.
        </p>
        {logPath && (
          <p className="path">
            <code>{logPath}</code>
          </p>
        )}
        {pathError && (
          <p className="banner error">
            Could not resolve log path: <code>{pathError}</code>
          </p>
        )}
        {!logPath && !pathError && (
          <p className="banner warn">
            <strong>No nanoclaw.log found.</strong>
            <span>
              {' '}
              Either NanoClaw isn&apos;t installed yet, or the launchd plist
              writes its log somewhere unexpected. The Doctor falls back to{' '}
              <code>~/Documents/NanoClaw/nanoclaw/logs/nanoclaw.log</code>{' '}
              when the plist lookup fails.
            </span>
          </p>
        )}
      </header>

      <div className="toolbar">
        <div className="toolbar-group">
          <label htmlFor="lines">Lines</label>
          <select
            id="lines"
            value={lines}
            disabled={busy}
            onChange={(e) => setLines(Number(e.target.value))}
          >
            {LINES_OPTIONS.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </div>

        <div className="toolbar-group">
          <button type="button" onClick={refresh} disabled={busy || !logPath}>
            {busy ? 'Loading…' : 'Refresh'}
          </button>
          <label className="live-toggle">
            <input
              type="checkbox"
              checked={live}
              onChange={(e) => setLive(e.target.checked)}
            />
            Live
          </label>
          <button
            type="button"
            onClick={onCopy}
            disabled={!content || busy}
            title="Copy current tail to clipboard"
          >
            Copy
          </button>
        </div>

        <div className="toolbar-group meta">
          {lastFetchedAt && (
            <span className="muted">Updated {timeAgo(lastFetchedAt)}</span>
          )}
        </div>
      </div>

      {contentError && (
        <div className="banner error">
          Tail failed: <code>{contentError}</code>
        </div>
      )}

      <pre ref={preRef} className="log-pane" onScroll={onScroll}>
        {content || (busy ? '' : '— empty —')}
      </pre>
    </div>
  );
}

function timeAgo(ts: number): string {
  const secs = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (secs < 5) return 'just now';
  if (secs < 60) return `${secs}s ago`;
  const m = Math.floor(secs / 60);
  return `${m}m ago`;
}

function Styles() {
  return (
    <style>{`
      :root, html, body, #root {
        height: 100%;
      }
      body { overflow: hidden; }
      .logs-shell {
        display: flex;
        flex-direction: column;
        height: 100vh;
        max-width: 100%;
        padding: 1rem 1.1rem 0.6rem;
        color: var(--color-ink);
        gap: 0.75rem;
        box-sizing: border-box;
      }
      .logs-shell header { flex: 0 0 auto; }
      .brand {
        display: inline-flex;
        align-items: center;
        gap: 0.5rem;
        font-size: 0.85rem;
        font-weight: 500;
      }
      .brand .dot {
        width: 0.55rem;
        height: 0.55rem;
        border-radius: 9999px;
        background: var(--color-accent);
      }
      h1 {
        font-size: 1.4rem;
        line-height: 1.2;
        letter-spacing: -0.015em;
        margin: 0.5rem 0 0.3rem;
        font-weight: 500;
      }
      .lede {
        color: var(--color-ink-muted);
        font-size: 0.8rem;
        margin: 0 0 0.4rem;
      }
      .lede code, .path code {
        font-family: var(--font-mono);
        font-size: 0.74rem;
        background: var(--color-bg-subtle);
        padding: 0.05rem 0.35rem;
        border-radius: 0.35rem;
      }
      .path {
        margin: 0 0 0.3rem;
        color: var(--color-ink-muted);
        font-size: 0.78rem;
      }
      .banner {
        border-radius: 0.5rem;
        padding: 0.55rem 0.75rem;
        margin: 0.4rem 0 0;
        font-size: 0.82rem;
      }
      .banner.error {
        background: rgba(220, 50, 47, 0.08);
        color: #d33;
      }
      .banner.warn {
        background: rgba(255, 170, 0, 0.1);
        color: var(--color-ink);
      }

      .toolbar {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 0.85rem;
        flex: 0 0 auto;
        padding: 0.55rem 0.7rem;
        border: 1px solid var(--color-hairline);
        border-radius: var(--radius-2xl);
        background: var(--color-bg-elevated);
      }
      .toolbar-group {
        display: inline-flex;
        align-items: center;
        gap: 0.5rem;
        font-size: 0.85rem;
      }
      .toolbar-group.meta { margin-left: auto; }
      .toolbar select, .toolbar button {
        background: var(--color-bg);
        color: var(--color-ink);
        border: 1px solid var(--color-hairline);
        border-radius: 0.5rem;
        padding: 0.32rem 0.7rem;
        font-size: 0.82rem;
        font-family: inherit;
        cursor: pointer;
      }
      .toolbar button:hover:not(:disabled) {
        background: var(--color-bg-subtle);
      }
      .toolbar button:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
      .live-toggle {
        display: inline-flex;
        align-items: center;
        gap: 0.3rem;
        cursor: pointer;
      }
      .muted { color: var(--color-ink-muted); font-size: 0.8rem; }

      .log-pane {
        flex: 1 1 auto;
        min-height: 0;
        margin: 0;
        padding: 0.75rem 0.9rem;
        background: #0d1117;
        color: #c9d1d9;
        border: 1px solid var(--color-hairline);
        border-radius: var(--radius-2xl);
        font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
        font-size: 0.78rem;
        line-height: 1.45;
        overflow: auto;
        white-space: pre;
        tab-size: 2;
      }
    `}</style>
  );
}
