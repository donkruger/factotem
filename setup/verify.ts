/**
 * Step: verify — End-to-end health check of the full installation.
 * Replaces 09-verify.sh
 *
 * Reads the groups DB via setup/db-probe (better-sqlite3, no sqlite3 CLI) and
 * does platform-aware service checks.
 */
import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { STORE_DIR } from '../src/config.js';
import { readEnvFile } from '../src/env.js';
import { logger } from '../src/logger.js';
import {
  dbErrorHint,
  readAgentModels,
  readRegisteredGroupCount,
} from './db-probe.js';
import {
  getPlatform,
  getServiceManager,
  hasSystemd,
  isRoot,
} from './platform.js';
import { emitStatus } from './status.js';

/**
 * Decide overall verify status from the individual signals.
 *
 * Group-count semantics: `null` = unknown (the DB could not be read). Unknown
 * is NON-blocking — a transient/ABI DB-read failure must not by itself fail an
 * otherwise-healthy deployment (the historical false-negative this guards). A
 * known count of 0 (DB read fine, no groups registered) still fails: that is
 * genuinely incomplete setup.
 */
/** Live-log path since the 2026-06-09 plist regeneration. `logs/nanoclaw.log`
 *  is stale — grepping it silently misleads recovery (ben-log 2026-06-12). */
const LIVE_LOG_REL = '.logs/nanoclaw.out.log';

interface AuthProbe {
  mode: string;
  live: 'live' | 'rejected' | 'unknown';
  hint: string;
}

/**
 * Live auth health — reuses `scripts/set-auth-mode.sh status`, which already
 * does a real probe against Anthropic (mode + "auth is live" / "rejected").
 * Parsed, never reimplemented. Any failure (script missing, non-darwin, OneCLI
 * down, timeout) collapses to `unknown` so it warns rather than hard-fails.
 */
function probeAuthMode(projectRoot: string): AuthProbe {
  const script = path.join(projectRoot, 'scripts', 'set-auth-mode.sh');
  if (!fs.existsSync(script)) {
    return { mode: 'unknown', live: 'unknown', hint: '' };
  }
  try {
    const out = execSync(`bash ${JSON.stringify(script)} status`, {
      encoding: 'utf-8',
      timeout: 20000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const mode = (out.match(/^\s*mode:\s*(\S+)/m)?.[1] ?? 'unknown').trim();
    const probeLine = (out.match(/^\s*probe:\s*(.+)$/m)?.[1] ?? '').toLowerCase();
    let live: AuthProbe['live'] = 'unknown';
    if (/\b(live|accepted|ok)\b/.test(probeLine)) live = 'live';
    else if (/\b(reject|invalid|fail|error)\b/.test(probeLine)) live = 'rejected';
    const hint =
      live === 'rejected'
        ? 'Anthropic rejected the stored credential. In subscription mode re-mint a token (`claude setup-token`) and `scripts/set-auth-mode.sh ...`; in api-key mode rotate the key.'
        : '';
    return { mode, live, hint };
  } catch {
    return { mode: 'unknown', live: 'unknown', hint: '' };
  }
}

interface OrchHealth {
  onecliReachable: boolean | null;
  whatsappAuthenticated: boolean | null;
}

/** When the service is up, one /health read gives both OneCLI reachability and
 *  the LIVE WhatsApp connected state — the latter replaces the misleading
 *  "store/auth dir is non-empty" heuristic (the stale write-once trap). */
async function probeOrchestratorHealth(): Promise<OrchHealth> {
  const port = process.env.NANOCLAW_HTTP_PORT || '7842';
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: ctrl.signal,
    });
    clearTimeout(t);
    const h = (await res.json()) as {
      onecli?: { reachable?: boolean };
      whatsapp?: { authenticated?: boolean };
    };
    return {
      onecliReachable: h.onecli?.reachable ?? null,
      whatsappAuthenticated: h.whatsapp?.authenticated ?? null,
    };
  } catch {
    return { onecliReachable: null, whatsappAuthenticated: null };
  }
}

/** Direct OneCLI gateway probe — used as a fallback when the orchestrator (and
 *  thus its /health) is down, so the doctor can still tell OneCLI apart. */
async function probeOneCliDirect(): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 3000);
    const res = await fetch('http://127.0.0.1:10254/', { signal: ctrl.signal });
    clearTimeout(t);
    return res.status < 500;
  } catch {
    return false;
  }
}

/** Fallback WhatsApp signal when the service is down: scan the tail of the
 *  live log for the last connect/logout marker. */
function scanWhatsAppLog(projectRoot: string): boolean | null {
  const logPath = path.join(projectRoot, LIVE_LOG_REL);
  try {
    const text = fs.readFileSync(logPath, 'utf-8');
    const tail = text.slice(-200000); // last ~200KB is plenty
    const lastConnect = tail.lastIndexOf('Connected to WhatsApp');
    const lastLogout = tail.lastIndexOf('Logged out');
    if (lastConnect === -1 && lastLogout === -1) return null;
    return lastConnect > lastLogout;
  } catch {
    return null;
  }
}

/** Flag the dot-vs-dash model-ID typo class (`claude-opus-4.6` → 404s every
 *  turn) and empty models. Conservative: we can't validate "is a real model"
 *  without an API call, so we only flag clear, zero-false-positive problems. */
function badModelId(model: string): boolean {
  const m = model.replace(/^anthropic\//, '').trim();
  if (!m) return true;
  // A dotted version segment in a claude id is the exact 2026-06-12 typo.
  if (/^claude-[a-z]+-\d+\.\d+/.test(m)) return true;
  return false;
}

export function decideVerifyStatus(signals: {
  service: string;
  credentials: string;
  anyChannelConfigured: boolean;
  groupCount: number | null;
}): 'success' | 'failed' {
  const groupsHealthy =
    signals.groupCount === null || signals.groupCount > 0;
  return signals.service === 'running' &&
    signals.credentials !== 'missing' &&
    signals.anyChannelConfigured &&
    groupsHealthy
    ? 'success'
    : 'failed';
}

export async function run(_args: string[]): Promise<void> {
  const projectRoot = process.cwd();
  const platform = getPlatform();
  const homeDir = os.homedir();

  logger.info('Starting verification');

  // 1. Check service status
  let service = 'not_found';
  const mgr = getServiceManager();

  if (mgr === 'launchd') {
    try {
      const output = execSync('launchctl list', { encoding: 'utf-8' });
      // Match the EXACT `com.nanoclaw` label, not a substring — otherwise
      // `com.nanoclaw.oauth-refresh` (a watcher, PID '-') or a
      // `com.nanoclaw-v2-*` instance is picked first and the running
      // orchestrator is misreported as stopped. launchctl list rows are
      // `PID<TAB>STATUS<TAB>LABEL`.
      const line = output
        .split('\n')
        .find((l) => l.trim().split(/\s+/).pop() === 'com.nanoclaw');
      if (line) {
        const pidField = line.trim().split(/\s+/)[0];
        service = pidField !== '-' && pidField ? 'running' : 'stopped';
      }
    } catch {
      // launchctl not available
    }
  } else if (mgr === 'systemd') {
    const prefix = isRoot() ? 'systemctl' : 'systemctl --user';
    try {
      execSync(`${prefix} is-active nanoclaw`, { stdio: 'ignore' });
      service = 'running';
    } catch {
      try {
        const output = execSync(`${prefix} list-unit-files`, {
          encoding: 'utf-8',
        });
        if (output.includes('nanoclaw')) {
          service = 'stopped';
        }
      } catch {
        // systemctl not available
      }
    }
  } else {
    // Check for nohup PID file
    const pidFile = path.join(projectRoot, 'nanoclaw.pid');
    if (fs.existsSync(pidFile)) {
      try {
        const raw = fs.readFileSync(pidFile, 'utf-8').trim();
        const pid = Number(raw);
        if (raw && Number.isInteger(pid) && pid > 0) {
          process.kill(pid, 0);
          service = 'running';
        }
      } catch {
        service = 'stopped';
      }
    }
  }
  logger.info({ service }, 'Service status');

  // 2. Check container runtime
  let containerRuntime = 'none';
  try {
    execSync('command -v container', { stdio: 'ignore' });
    containerRuntime = 'apple-container';
  } catch {
    try {
      execSync('docker info', { stdio: 'ignore' });
      containerRuntime = 'docker';
    } catch {
      // No runtime
    }
  }

  // 3. Check credentials
  let credentials = 'missing';
  const envFile = path.join(projectRoot, '.env');
  if (fs.existsSync(envFile)) {
    const envContent = fs.readFileSync(envFile, 'utf-8');
    if (/^(CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY|ONECLI_URL)=/m.test(envContent)) {
      credentials = 'configured';
    }
  }

  // 4. Check channel auth (detect configured channels by credentials)
  const envVars = readEnvFile([
    'TELEGRAM_BOT_TOKEN',
    'SLACK_BOT_TOKEN',
    'SLACK_APP_TOKEN',
    'DISCORD_BOT_TOKEN',
  ]);

  const channelAuth: Record<string, string> = {};

  // WhatsApp: check for auth credentials on disk
  const authDir = path.join(projectRoot, 'store', 'auth');
  if (fs.existsSync(authDir) && fs.readdirSync(authDir).length > 0) {
    channelAuth.whatsapp = 'authenticated';
  }

  // Token-based channels: check .env
  if (process.env.TELEGRAM_BOT_TOKEN || envVars.TELEGRAM_BOT_TOKEN) {
    channelAuth.telegram = 'configured';
  }
  if (
    (process.env.SLACK_BOT_TOKEN || envVars.SLACK_BOT_TOKEN) &&
    (process.env.SLACK_APP_TOKEN || envVars.SLACK_APP_TOKEN)
  ) {
    channelAuth.slack = 'configured';
  }
  if (process.env.DISCORD_BOT_TOKEN || envVars.DISCORD_BOT_TOKEN) {
    channelAuth.discord = 'configured';
  }

  const configuredChannels = Object.keys(channelAuth);
  const anyChannelConfigured = configuredChannels.length > 0;

  // 5. Check registered groups (using better-sqlite3, not sqlite3 CLI).
  // `count === null` means the DB existed but could not be read (e.g. a
  // better-sqlite3 ABI mismatch). That is "unknown", NOT "0 groups" — see
  // db-probe.ts. We log the error rather than swallowing it, and below it is
  // treated as non-blocking for overall status.
  const dbPath = path.join(STORE_DIR, 'messages.db');
  const groupsProbe = readRegisteredGroupCount(dbPath);
  if (groupsProbe.error) {
    logger.error(
      { dbPath, error: groupsProbe.error },
      'Could not read registered_groups; group count is unknown (not zero)',
    );
  }

  // 6. Check mount allowlist
  let mountAllowlist = 'missing';
  if (
    fs.existsSync(
      path.join(homeDir, '.config', 'nanoclaw', 'mount-allowlist.json'),
    )
  ) {
    mountAllowlist = 'configured';
  }

  // 7. Incident-grounded probes (ben-log 2026-06): live auth, OneCLI gateway,
  //    WhatsApp connected (NOT the stale dir heuristic), model-ID validity,
  //    large-session resume risk. These add fields only — they do NOT feed
  //    decideVerifyStatus (the wizard's gate is unchanged); `claw doctor`
  //    renders them and computes its own verdict.
  const auth = probeAuthMode(projectRoot);

  const orch = service === 'running' ? await probeOrchestratorHealth() : null;
  const onecliReachable =
    orch?.onecliReachable ?? (service === 'running' ? null : await probeOneCliDirect());
  const whatsappConnected =
    orch?.whatsappAuthenticated ?? scanWhatsAppLog(projectRoot);

  // Model-ID validity across agents (catches the dot-vs-dash 404 typo).
  const agentProbe = readAgentModels(dbPath);
  let modelCheck = 'ok';
  let modelHint = '';
  if (agentProbe.error) {
    modelCheck = 'unknown';
    modelHint = dbErrorHint(agentProbe.error);
  } else if (agentProbe.models && agentProbe.models.length > 0) {
    const bad = agentProbe.models.filter((m) => badModelId(m.provider_model));
    if (bad.length > 0) {
      modelCheck = 'bad';
      const offenders = bad
        .map((m) => `${m.name || m.id}=${m.provider_model || '(empty)'}`)
        .join(', ');
      modelHint = `Invalid model id(s): ${offenders}. Anthropic API ids use dashes, not dots (e.g. claude-opus-4-6, not claude-opus-4.6). Fix the agent's provider_model.`;
    }
  }

  // Large pinned session → slow/hung resume (the 3.4MB GGA incident).
  let bigSession = '';
  try {
    const sessRoot = path.join(projectRoot, 'data', 'sessions');
    if (fs.existsSync(sessRoot)) {
      for (const grp of fs.readdirSync(sessRoot)) {
        const projDir = path.join(
          sessRoot,
          grp,
          '.claude',
          'projects',
          '-workspace-group',
        );
        if (!fs.existsSync(projDir)) continue;
        let maxBytes = 0;
        for (const f of fs.readdirSync(projDir)) {
          if (!f.endsWith('.jsonl')) continue;
          const sz = fs.statSync(path.join(projDir, f)).size;
          if (sz > maxBytes) maxBytes = sz;
        }
        if (maxBytes > 2 * 1024 * 1024) {
          bigSession = `${grp}:${(maxBytes / 1024 / 1024).toFixed(1)}MB`;
          break;
        }
      }
    }
  } catch {
    /* best-effort */
  }

  // Determine overall status (see decideVerifyStatus — an unknown group count
  // from a failed DB read is non-blocking, a known 0 still fails).
  const status = decideVerifyStatus({
    service,
    credentials,
    anyChannelConfigured,
    groupCount: groupsProbe.count,
  });

  logger.info(
    { status, channelAuth, registeredGroups: groupsProbe.count },
    'Verification complete',
  );

  const fields: Record<string, string | number | boolean> = {
    SERVICE: service,
    CONTAINER_RUNTIME: containerRuntime,
    CREDENTIALS: credentials,
    CONFIGURED_CHANNELS: configuredChannels.join(','),
    CHANNEL_AUTH: JSON.stringify(channelAuth),
    REGISTERED_GROUPS:
      groupsProbe.count === null ? 'unknown' : groupsProbe.count,
    MOUNT_ALLOWLIST: mountAllowlist,
    AUTH_MODE: auth.mode,
    AUTH_LIVE: auth.live,
    ONECLI: onecliReachable === null ? 'unknown' : onecliReachable ? 'reachable' : 'down',
    WHATSAPP_CONNECTED:
      whatsappConnected === null ? 'unknown' : whatsappConnected ? 'true' : 'false',
    MODEL_CHECK: modelCheck,
    LOG_PATH: LIVE_LOG_REL,
    STATUS: status,
    LOG: 'logs/setup.log',
  };
  if (auth.hint) fields.AUTH_HINT = auth.hint;
  if (modelHint) fields.MODEL_HINT = modelHint;
  if (bigSession) fields.BIG_SESSION = bigSession;
  // Surface a failed DB read as distinct fields so consumers (CLI wizard, GUI
  // doctor, `claw doctor`) can tell "couldn't read the DB" apart from "0 groups"
  // instead of rendering a misleading zero.
  if (groupsProbe.error) {
    fields.DB_ERROR = groupsProbe.error;
    fields.DB_ERROR_HINT = dbErrorHint(groupsProbe.error);
  }

  emitStatus('VERIFY', fields);

  if (status === 'failed') process.exit(1);
}
