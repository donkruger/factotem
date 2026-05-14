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

import { ONECLI_URL, PROJECT_ROOT, STORE_DIR } from '../config.js';
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
  };
  onecli: {
    reachable: boolean;
    latency_ms: number | null;
    auth_mode: string | null;
  };
  whatsapp: {
    authenticated: boolean;
    last_message_at: string | null;
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
    };
  } catch (err) {
    logger.debug({ err }, 'health: docker probe failed');
    return { running: false, containers_active: 0, image_tag: null };
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
  let authenticated = false;
  let lastMessageAt: string | null = null;
  try {
    // Canonical signal: store/auth/creds.json. Baileys writes this on
    // successful pair and re-reads it on every connection — its
    // presence is what makes the agent actually responsive. The
    // transient store/auth-status.txt was only ever written by the
    // pairing flow's auth script and isn't kept current post-pair,
    // so a stale or deleted auth-status.txt produced false negatives
    // ("Not paired" in the dashboard while the agent was happily
    // replying in WhatsApp).
    const credsPath = path.join(STORE_DIR, 'auth', 'creds.json');
    authenticated = fs.existsSync(credsPath);

    // Defence-in-depth: if creds.json somehow isn't there but the
    // auth-status hand-off does say 'authenticated', accept that too.
    if (!authenticated) {
      const authStatusPath = path.join(STORE_DIR, 'auth-status.txt');
      if (fs.existsSync(authStatusPath)) {
        const status = fs.readFileSync(authStatusPath, 'utf-8').trim();
        authenticated = status === 'authenticated';
      }
    }
  } catch {
    /* fall through */
  }
  try {
    // Most recent inbound or outbound message timestamp. Cheap query: indexed
    // by timestamp DESC. messages.timestamp is stored as ISO 8601.
    const row = getProbeDb()
      .prepare('SELECT timestamp FROM messages ORDER BY timestamp DESC LIMIT 1')
      .get() as { timestamp?: string } | undefined;
    if (row?.timestamp) lastMessageAt = row.timestamp;
  } catch (err) {
    logger.debug({ err }, 'health: messages last-timestamp probe failed');
  }
  return { authenticated, last_message_at: lastMessageAt };
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
