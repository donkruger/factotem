/**
 * Health snapshot endpoint backing for the Factotem dashboard.
 *
 * Returns a structured JSON snapshot of the NanoClaw deployment's state
 * across five subsystems (machine, nanoclaw, docker, onecli, whatsapp,
 * open_dm). Cached for 5 seconds so the dashboard's polling
 * (every 2–5s) doesn't thrash the underlying probes.
 *
 * T-1778233000000 (Phase 0.1 of Factotem Dashboard v1 epic).
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import Database from 'better-sqlite3';

import {
  MAX_CONCURRENT_CONTAINERS,
  ONECLI_URL,
  PROJECT_ROOT,
  STORE_DIR,
} from '../config.js';
import { logger } from '../logger.js';
import { getMachineIdentity, MachineIdentity } from './machine-identity.js';

const PACKAGE_VERSION: string = (() => {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf-8'),
    );
    return typeof pkg.version === 'string' ? pkg.version : 'unknown';
  } catch {
    return 'unknown';
  }
})();

export interface HealthSnapshot {
  machine: MachineIdentity & { tailscale_ip: string | null };
  nanoclaw: {
    running: true;
    pid: number;
    uptime_seconds: number;
    version: string;
  };
  docker: {
    running: boolean;
    containers_active: number;
    image_tag: string | null;
    /**
     * Global concurrency ceiling (MAX_CONCURRENT_CONTAINERS).
     * Surfaced so the dashboard's Activity row can render
     * `concurrent_at_spawn` as `N / max` rather than a bare integer.
     * v1.2.1-finish-blueprint § 3.
     */
    max_concurrent: number;
  };
  onecli: {
    reachable: boolean;
    latency_ms: number | null;
    auth_mode: string | null;
  };
  whatsapp: {
    /**
     * Top-level summary — `true` if at least one pairing is authenticated.
     * Preserved for v1.0 / v1.2 dashboards that read `whatsapp.authenticated`.
     */
    authenticated: boolean;
    last_message_at: string | null;
    /**
     * Per-pairing breakdown (multi-agent-completion-blueprint § 4.1).
     * Empty array on first boot before the migration runs. The
     * deployment's shared pairing is the first entry.
     */
    pairings: Array<{
      id: string;
      display_name: string;
      authenticated: boolean;
      last_connected_at: string | null;
      phone_hint: string | null;
      is_shared: boolean;
    }>;
  };
  open_dm: {
    enabled: boolean;
    daily_budget_cents: number | null;
    today_spent_cents: number;
  };
}

let cachedSnapshot: HealthSnapshot | undefined;
let cachedAt = 0;
const CACHE_TTL_MS = 5_000;

/**
 * Returns the current health snapshot, possibly served from a 5-second
 * cache. On first call the cache is empty and probes run synchronously.
 */
export async function getHealthSnapshot(): Promise<HealthSnapshot> {
  const now = Date.now();
  if (cachedSnapshot && now - cachedAt < CACHE_TTL_MS) {
    return cachedSnapshot;
  }

  const [docker, onecli, whatsapp, openDm, tailscaleIp] = await Promise.all([
    probeDocker(),
    probeOneCLI(),
    probeWhatsApp(),
    probeOpenDm(),
    probeTailscale(),
  ]);

  const snapshot: HealthSnapshot = {
    machine: { ...getMachineIdentity(), tailscale_ip: tailscaleIp },
    nanoclaw: {
      running: true,
      pid: process.pid,
      uptime_seconds: Math.floor(process.uptime()),
      version: process.env.NANOCLAW_VERSION ?? PACKAGE_VERSION,
    },
    docker,
    onecli,
    whatsapp,
    open_dm: openDm,
  };

  cachedSnapshot = snapshot;
  cachedAt = now;
  return snapshot;
}

async function probeDocker(): Promise<HealthSnapshot['docker']> {
  try {
    // Lightweight probe — just checks engine responsiveness + counts running containers
    const out = execSync(
      "docker ps --filter 'name=nanoclaw' --format '{{.Names}}' 2>/dev/null | wc -l",
      { encoding: 'utf-8', timeout: 3000 },
    ).trim();
    const containersActive = parseInt(out, 10) || 0;
    let imageTag: string | null = null;
    try {
      const tagPath = path.join(PROJECT_ROOT, '.container-image-tag');
      if (fs.existsSync(tagPath)) {
        imageTag = fs.readFileSync(tagPath, 'utf-8').trim();
      }
    } catch {
      /* fall through */
    }
    return {
      running: true,
      containers_active: containersActive,
      image_tag: imageTag,
      max_concurrent: MAX_CONCURRENT_CONTAINERS,
    };
  } catch (err) {
    logger.debug({ err }, 'health: docker probe failed');
    return {
      running: false,
      containers_active: 0,
      image_tag: null,
      max_concurrent: MAX_CONCURRENT_CONTAINERS,
    };
  }
}

async function probeOneCLI(): Promise<HealthSnapshot['onecli']> {
  let authMode: string | null = null;
  try {
    const authModePath = path.join(
      process.env.HOME ?? '',
      '.config',
      'nanoclaw',
      'auth-mode',
    );
    if (fs.existsSync(authModePath)) {
      authMode = fs.readFileSync(authModePath, 'utf-8').trim();
    }
  } catch {
    /* fall through */
  }
  const start = Date.now();
  try {
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 3000);
    const res = await fetch(ONECLI_URL + '/', { signal: ctrl.signal });
    clearTimeout(timeout);
    return {
      reachable: res.status < 500,
      latency_ms: Date.now() - start,
      auth_mode: authMode,
    };
  } catch {
    return { reachable: false, latency_ms: null, auth_mode: authMode };
  }
}

// Lazy singleton database connection for read-only queries inside probes.
// Same pattern as src/http/api.ts. Read-only avoids contention with the
// orchestrator's writer connection.
let probeDb: Database.Database | undefined;
function getProbeDb(): Database.Database {
  if (!probeDb) {
    probeDb = new Database(path.join(STORE_DIR, 'messages.db'), {
      readonly: true,
    });
  }
  return probeDb;
}

async function probeWhatsApp(): Promise<HealthSnapshot['whatsapp']> {
  let lastMessageAt: string | null = null;
  try {
    // Most recent inbound or outbound message timestamp. Cheap query:
    // indexed by timestamp DESC. messages.timestamp is stored as ISO 8601.
    const row = getProbeDb()
      .prepare('SELECT timestamp FROM messages ORDER BY timestamp DESC LIMIT 1')
      .get() as { timestamp?: string } | undefined;
    if (row?.timestamp) lastMessageAt = row.timestamp;
  } catch (err) {
    logger.debug({ err }, 'health: messages last-timestamp probe failed');
  }

  // Per-pairing status (multi-agent-completion-blueprint § 4.1). Each
  // pairing's `auth_path` carries its own Baileys creds.json — we
  // check existence per row. The shared pairing keeps the legacy
  // `store/auth/` path so v1.0 operators see the same authenticated
  // state they always did.
  let pairings: HealthSnapshot['whatsapp']['pairings'] = [];
  try {
    const rows = getProbeDb()
      .prepare(
        `SELECT id, display_name, auth_path, last_connected_at,
                phone_hint, is_shared
           FROM channel_pairings
          WHERE kind = 'whatsapp'
          ORDER BY is_shared DESC, created_at ASC`,
      )
      .all() as Array<{
      id: string;
      display_name: string;
      auth_path: string;
      last_connected_at: string | null;
      phone_hint: string | null;
      is_shared: number;
    }>;
    pairings = rows.map((r) => {
      let authed = false;
      try {
        authed = fs.existsSync(path.join(r.auth_path, 'creds.json'));
      } catch {
        /* fall through */
      }
      // Defence-in-depth: read the auth-status hand-off for the
      // shared pairing (legacy compatibility — new pairings don't
      // use auth-status.txt).
      if (!authed && r.is_shared === 1) {
        try {
          const ap = path.join(STORE_DIR, 'auth-status.txt');
          if (fs.existsSync(ap)) {
            authed = fs.readFileSync(ap, 'utf-8').trim() === 'authenticated';
          }
        } catch {
          /* fall through */
        }
      }
      return {
        id: r.id,
        display_name: r.display_name,
        authenticated: authed,
        last_connected_at: r.last_connected_at,
        phone_hint: r.phone_hint,
        is_shared: r.is_shared === 1,
      };
    });
  } catch (err) {
    logger.debug({ err }, 'health: channel_pairings probe failed');
  }

  // Top-level summary: true if *any* pairing is authenticated. v1.0 /
  // v1.2 dashboards read this field; v1.2.1+ surfaces also read the
  // per-pairing array.
  const authenticated =
    pairings.length > 0
      ? pairings.some((p) => p.authenticated)
      : (() => {
          // First-boot path before channel_pairings is populated —
          // fall back to the legacy creds.json probe so a brand-new
          // install doesn't report unhealthy.
          try {
            return fs.existsSync(path.join(STORE_DIR, 'auth', 'creds.json'));
          } catch {
            return false;
          }
        })();

  return { authenticated, last_message_at: lastMessageAt, pairings };
}

async function probeTailscale(): Promise<string | null> {
  // Tailscale IP for the dashboard's machine-identity strip. macOS GUI
  // installs ship the binary at /Applications/Tailscale.app/Contents/MacOS/Tailscale
  // (no PATH symlink unless the operator added one). Probe both common
  // paths with a short timeout — null is the graceful fallback (e.g. when
  // Tailscale isn't running, isn't logged in, or isn't installed).
  const candidates = [
    '/usr/local/bin/tailscale',
    '/opt/homebrew/bin/tailscale',
    '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
  ];
  for (const bin of candidates) {
    if (!fs.existsSync(bin)) continue;
    try {
      const out = execSync(`"${bin}" ip -4 2>/dev/null`, {
        encoding: 'utf-8',
        timeout: 2000,
      }).trim();
      // First line should be the IPv4 address.
      const ip = out.split('\n')[0]?.trim();
      if (ip && /^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return ip;
    } catch {
      /* try next */
    }
  }
  return null;
}

async function probeOpenDm(): Promise<HealthSnapshot['open_dm']> {
  // open_dm config lives on the main group's container_config JSON in SQLite.
  // Probe via the existing readonly connection — same pattern as probeWhatsApp.
  // Fail-soft on every error: an unreadable DB or malformed JSON degrades to
  // the original placeholder shape, which is harmless for the dashboard.
  try {
    const row = getProbeDb()
      .prepare(
        'SELECT container_config FROM registered_groups WHERE is_main = 1 LIMIT 1',
      )
      .get() as { container_config: string | null } | undefined;
    if (!row?.container_config) {
      return { enabled: false, daily_budget_cents: null, today_spent_cents: 0 };
    }
    const parsed = JSON.parse(row.container_config) as {
      openMode?: { enabled?: boolean; dailyBudgetCents?: number | null };
    };
    const openMode = parsed.openMode;
    if (!openMode?.enabled) {
      return { enabled: false, daily_budget_cents: null, today_spent_cents: 0 };
    }
    const today = new Date().toISOString().slice(0, 10);
    let todaySpentCents = 0;
    try {
      const spend = getProbeDb()
        .prepare('SELECT est_cost_cents FROM open_spend_log WHERE date = ?')
        .get(today) as { est_cost_cents?: number } | undefined;
      todaySpentCents = spend?.est_cost_cents ?? 0;
    } catch {
      /* open_spend_log may not exist on fresh installs — leave at 0 */
    }
    return {
      enabled: true,
      daily_budget_cents: openMode.dailyBudgetCents ?? null,
      today_spent_cents: todaySpentCents,
    };
  } catch (err) {
    logger.debug({ err }, 'health: open-dm probe failed');
    return { enabled: false, daily_budget_cents: null, today_spent_cents: 0 };
  }
}
