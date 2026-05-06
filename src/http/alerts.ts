/**
 * Alert detection for the Factotem dashboard's `/alerts` panel.
 *
 * Surfaces the Round 7 ben-log-grounded top-5 failure modes:
 *   1. Docker wedge (Docker engine + OneCLI gateway down)
 *   2. Error-string-in-reply (transient error patterns in recent logs)
 *   3. Auth-mode freshness (oauth-workaround watcher tick stale)
 *   4. Ghost-action divergence (turns claiming success but no tool calls)
 *   5. WhatsApp respawn-counter (reconnecting-loop in recent logs)
 *
 * T-1778244000000 (Phase 6 of Factotem Dashboard v1 epic).
 *
 * Compute model: lazy on each `/api/alerts` request, with a per-detection
 * cache so log-tailing doesn't thrash on every poll. The dashboard polls
 * every 10s; each individual probe is cached 30s. Computation never
 * blocks NanoClaw's message loop because all reads are cheap (small log
 * tail, single-row SQLite query, fs.stat) and run inline in the route
 * handler.
 */

import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import Database from 'better-sqlite3';

import { STORE_DIR, PROJECT_ROOT } from '../config.js';
import { logger } from '../logger.js';
import { getHealthSnapshot } from './health.js';

export type AlertSeverity = 'critical' | 'warning' | 'info';

export interface Alert {
  /** Stable string id; one alert per id can be active at a time. */
  id:
    | 'docker_wedge'
    | 'error_string_in_reply'
    | 'auth_mode_freshness'
    | 'ghost_action_divergence'
    | 'wa_respawn_counter';
  severity: AlertSeverity;
  title: string;
  detail: string;
  recommendation?: string;
  /** URL the operator can follow for the recovery procedure. */
  recovery_url?: string;
  /**
   * Signals the dashboard to render a recovery action. Currently only
   * `restart_stack` is implemented (env-var-gated).
   */
  recovery_action?: 'restart_stack';
  /** ISO timestamp when this snapshot was computed. */
  detected_at: string;
}

export interface AlertsResponse {
  alerts: Alert[];
  /** True iff the operator opted into the Restart Stack button via env var. */
  restart_stack_enabled: boolean;
  /** Snapshot moment, also returned per-alert for client-side dedup. */
  detected_at: string;
}

const OPERATIONS_RECOVERY_URL =
  'https://github.com/donkruger/benclaw/blob/main/docs/OPERATIONS.md#recovery';

// Per-detection caches so log tailing doesn't thrash. The dashboard
// polls /api/alerts every 10s, so 30s cache is safe.
const CACHE_TTL_MS = 30_000;
let cachedResponse: AlertsResponse | undefined;
let cachedAt = 0;

let probeDb: Database.Database | undefined;
function getProbeDb(): Database.Database {
  if (!probeDb) {
    probeDb = new Database(path.join(STORE_DIR, 'messages.db'), {
      readonly: true,
    });
  }
  return probeDb;
}

export function isRestartStackEnabled(): boolean {
  return process.env.NANOCLAW_DASHBOARD_ENABLE_RESTART_STACK === '1';
}

export async function getAlertsSnapshot(): Promise<AlertsResponse> {
  const now = Date.now();
  if (cachedResponse && now - cachedAt < CACHE_TTL_MS) {
    return cachedResponse;
  }

  const detected_at = new Date(now).toISOString();
  const alerts: Alert[] = [];

  // Pull the health snapshot once for shared probes.
  let health: Awaited<ReturnType<typeof getHealthSnapshot>> | undefined;
  try {
    health = await getHealthSnapshot();
  } catch (err) {
    logger.warn({ err }, 'alerts: getHealthSnapshot failed');
  }

  // 1. Docker wedge — Round 7 Rank 1 (3 incidents in 6 days)
  if (health) {
    const dockerDown = !health.docker.running;
    const onecliDown = !health.onecli.reachable;
    if (dockerDown || onecliDown) {
      const both = dockerDown && onecliDown;
      alerts.push({
        id: 'docker_wedge',
        severity: 'critical',
        title: both
          ? 'Docker + OneCLI both unreachable'
          : dockerDown
            ? 'Docker engine unreachable'
            : 'OneCLI gateway unreachable',
        detail: both
          ? 'The Docker daemon and the OneCLI gateway at 127.0.0.1:10254 are both unreachable. Containers cannot spawn; agent calls will fail.'
          : dockerDown
            ? 'Docker daemon is not responding to `docker ps`. Containers cannot spawn. Agent replies are blocked.'
            : 'OneCLI gateway at 127.0.0.1:10254 is unreachable. Anthropic credential injection is broken; new container turns will 401.',
        recommendation: both
          ? 'Restart Stack will SIGKILL Docker Desktop + the docker backend; macOS will respawn it. Use the Restart Stack button below if you have it enabled.'
          : 'Restart the affected service from the Operations runbook.',
        recovery_url: OPERATIONS_RECOVERY_URL,
        recovery_action: both ? 'restart_stack' : undefined,
        detected_at,
      });
    }
  }

  // 2. Error-string-in-reply — Round 7 Rank 2
  // Tail recent nanoclaw.log for transient-error patterns. The R7 patterns:
  // "Invalid API key", "API Error:", "Failed to authenticate".
  const errorPatternHit = probeRecentLogPattern(
    /Invalid API key|API Error:|Failed to authenticate|401 Unauthorized/i,
    60 * 60 * 1000, // 1h window
  );
  if (errorPatternHit) {
    alerts.push({
      id: 'error_string_in_reply',
      severity: 'critical',
      title: 'Transient-error string seen in recent logs',
      detail: `A recent log entry matched the auth/API error pattern: "${errorPatternHit.sample.slice(0, 80)}…" at ${errorPatternHit.timestamp ?? 'unknown time'}. If this matched a turn that also sent a reply, the user got an error string instead of an answer.`,
      recommendation:
        'Check OneCLI auth-mode and recent agent_turns for outcome=error. Inspect the matching log line in nanoclaw.log for full context.',
      recovery_url: OPERATIONS_RECOVERY_URL,
      detected_at,
    });
  }

  // 3. Auth-mode freshness — Round 7 Rank 3
  // For oauth-workaround mode, the launchd com.nanoclaw.oauth-refresh
  // watcher writes /tmp/nanoclaw-oauth-refresh.health on every tick.
  // Stale ticks indicate the watcher has stopped; the rotating subscription
  // token will expire and OneCLI calls will start 401-ing.
  const authMode = readAuthMode();
  if (authMode === 'oauth-workaround') {
    const healthFile = '/tmp/nanoclaw-oauth-refresh.health';
    let mtime: number | null = null;
    try {
      mtime = fs.statSync(healthFile).mtimeMs;
    } catch {
      /* file may not exist */
    }
    if (mtime === null) {
      alerts.push({
        id: 'auth_mode_freshness',
        severity: 'critical',
        title: 'OAuth refresh watcher missing',
        detail:
          'auth-mode is `oauth-workaround` but `/tmp/nanoclaw-oauth-refresh.health` does not exist. The launchd watcher is not running.',
        recommendation:
          'Reload `com.nanoclaw.oauth-refresh` via launchctl, or switch to api-key mode via `scripts/set-auth-mode.sh`.',
        recovery_url: OPERATIONS_RECOVERY_URL,
        detected_at,
      });
    } else {
      const ageMs = now - mtime;
      if (ageMs > 300_000) {
        alerts.push({
          id: 'auth_mode_freshness',
          severity: 'critical',
          title: 'OAuth refresh watcher stale',
          detail: `Last tick was ${Math.round(ageMs / 1000)}s ago (threshold: 300s). The rotating token is likely expired; OneCLI calls will 401.`,
          recommendation:
            'Reload `com.nanoclaw.oauth-refresh` via launchctl. If this recurs, switch to api-key mode.',
          recovery_url: OPERATIONS_RECOVERY_URL,
          detected_at,
        });
      } else if (ageMs > 90_000) {
        alerts.push({
          id: 'auth_mode_freshness',
          severity: 'warning',
          title: 'OAuth refresh watcher slow',
          detail: `Last tick was ${Math.round(ageMs / 1000)}s ago (threshold: 90s warning). Watcher may be stuck.`,
          recommendation:
            'Monitor for the next tick. If it crosses 300s, the warning escalates.',
          recovery_url: OPERATIONS_RECOVERY_URL,
          detected_at,
        });
      }
    }
  }

  // 4. Ghost-action divergence — Round 7 Rank 4
  // v1 heuristic: count recent agent_turns that succeeded but invoked zero
  // tools, where the prompt was substantial enough that we'd expect tool
  // use (>200 chars). True per-turn semantic verification is R8 follow-up.
  //
  // Plain-English framing for operators: when a long prompt asks the
  // agent to DO something (create a ticket, send a message, file an
  // entry) and the agent replies with a successful "done" but never
  // invoked any of its tools, the action almost certainly didn't
  // actually happen. The 2026-04-17 incident (logged in ben-log) is the
  // canonical example.
  const ghostHit = probeGhostActions();
  if (ghostHit && ghostHit.count > 0) {
    const n = ghostHit.count;
    alerts.push({
      id: 'ghost_action_divergence',
      severity: 'warning',
      title: `${n} agent repl${n === 1 ? 'y' : 'ies'} may have skipped expected actions`,
      detail: `In the last 24h, ${n} successful agent turn${n === 1 ? '' : 's'} responded to a substantial prompt (>200 chars) without invoking any tools. The agent likely answered "done" without actually doing anything — known as a "ghost action". This is a heuristic; not every match is a real ghost action.`,
      recommendation:
        'Open Activity, filter by outcome=success, and look for prompts that explicitly asked for an action (create, send, file, etc.). Cross-check against the ben-log entry for 2026-04-17 (the canonical ghost-tickets incident).',
      recovery_url: OPERATIONS_RECOVERY_URL,
      detected_at,
    });
  }

  // 5. WA respawn-counter — Round 7 Rank 5
  // Tail recent nanoclaw.log for "Reconnecting" or "Connection terminated"
  // lines in the last 60 seconds. A respawn-loop = >3 in 60s.
  const respawnCount = probeReconnectionsInLastMinute();
  if (respawnCount > 3) {
    alerts.push({
      id: 'wa_respawn_counter',
      severity: 'warning',
      title: 'WhatsApp connection looping',
      detail: `${respawnCount} reconnect events in the last 60 seconds (threshold: 3). Baileys is in a reconnect loop; messages may be intermittently lost.`,
      recommendation:
        'If sustained, the most likely cause is a stale Baileys session — re-pair WhatsApp via the setup wizard. Check `nanoclaw.log` for the underlying error.',
      recovery_url: OPERATIONS_RECOVERY_URL,
      detected_at,
    });
  }

  const response: AlertsResponse = {
    alerts,
    restart_stack_enabled: isRestartStackEnabled(),
    detected_at,
  };
  cachedResponse = response;
  cachedAt = now;
  return response;
}

function readAuthMode(): string | null {
  try {
    const p = path.join(os.homedir(), '.config', 'nanoclaw', 'auth-mode');
    if (fs.existsSync(p)) {
      return fs.readFileSync(p, 'utf-8').trim();
    }
  } catch {
    /* fall through */
  }
  return null;
}

function tailLogLines(maxLines: number): string[] {
  // Read the tail of nanoclaw.log without slurping the whole file. Bounded
  // by tail(1) — fast and uses constant memory regardless of log size.
  try {
    const logPath = path.join(PROJECT_ROOT, 'logs', 'nanoclaw.log');
    if (!fs.existsSync(logPath)) return [];
    const out = execSync(`tail -n ${maxLines} "${logPath}"`, {
      encoding: 'utf-8',
      timeout: 2_000,
    });
    return out.split('\n').filter(Boolean);
  } catch (err) {
    logger.debug({ err }, 'alerts: log tail failed');
    return [];
  }
}

function probeRecentLogPattern(
  pattern: RegExp,
  windowMs: number,
): { sample: string; timestamp: string | null } | null {
  const lines = tailLogLines(2_000);
  const cutoff = Date.now() - windowMs;
  // Walk newest to oldest; bail on first match within the window.
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!pattern.test(line)) continue;
    // pino structured logs prefix with `[HH:MM:SS.mmm]`; bail if too old.
    const ts = parseLogTimestamp(line);
    if (ts !== null && ts < cutoff) break;
    return {
      sample: line,
      timestamp: ts !== null ? new Date(ts).toISOString() : null,
    };
  }
  return null;
}

function parseLogTimestamp(line: string): number | null {
  // pino's pretty-output starts with `[HH:MM:SS.mmm]`; the date is
  // implicit (today). Combine with new Date() for a usable ms epoch.
  // Falls back to null when the format doesn't match.
  const m = line.match(/^\[(\d{2}):(\d{2}):(\d{2})\.(\d{3})\]/);
  if (!m) return null;
  const now = new Date();
  const candidate = new Date(now);
  candidate.setHours(
    parseInt(m[1], 10),
    parseInt(m[2], 10),
    parseInt(m[3], 10),
    parseInt(m[4], 10),
  );
  // If the parsed time is in the future, the log line is from yesterday.
  if (candidate.getTime() > now.getTime() + 5 * 60 * 1000) {
    candidate.setDate(candidate.getDate() - 1);
  }
  return candidate.getTime();
}

function probeReconnectionsInLastMinute(): number {
  const lines = tailLogLines(2_000);
  const cutoff = Date.now() - 60 * 1000;
  const pattern = /Reconnecting|Connection terminated|Connection closed/i;
  let count = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!pattern.test(line)) continue;
    const ts = parseLogTimestamp(line);
    if (ts !== null && ts < cutoff) break;
    count++;
  }
  return count;
}

function probeGhostActions(): { count: number } | null {
  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const row = getProbeDb()
      .prepare(
        `SELECT COUNT(*) AS n FROM agent_turns
         WHERE outcome = 'success'
           AND COALESCE(tool_use_count, 0) = 0
           AND COALESCE(prompt_chars, 0) > 200
           AND started_at >= ?`,
      )
      .get(since) as { n?: number } | undefined;
    if (!row) return { count: 0 };
    return { count: row.n ?? 0 };
  } catch (err) {
    logger.debug({ err }, 'alerts: ghost-action probe failed');
    return null;
  }
}
