// Open-DM mode SQLite patch.
//
// Mirrors cli/claw-setup/src/steps/08-configure-openmode.ts. The CLI
// step uses `better-sqlite3` directly; we use the `sqlite3` CLI
// (preinstalled on macOS, one-`apt install` on Linux) so we don't
// have to bundle a native module that electron-builder would need to
// rebuild per platform.
//
// SQLite operations:
//   READ   SELECT jid, name, container_config, is_main
//          FROM registered_groups WHERE is_main = 1 LIMIT 1
//   WRITE  UPDATE registered_groups SET container_config = ?
//          WHERE jid = ?
//
// After write, SIGHUP the orchestrator so it re-reads registered_groups.
// We get the pid from /health (already populated by health-probe.ts)
// rather than pgrep, which the CLI step uses.

import fs from 'fs'
import path from 'path'
import { runCommand } from './subprocess'
import { findBin } from './path-utils'
import { probeHealth } from './health-probe'

interface MainGroupRow {
  jid: string
  name: string
  container_config: string | null
  is_main: number
}

export interface OpenModeConfig {
  enabled: boolean
  dailyBudgetCents: number
  rateLimit?: { tokensPerHour: number; burstMax: number }
}

function dbPathFor(orchestratorRoot: string): string {
  return path.join(orchestratorRoot, 'store', 'messages.db')
}

// SQL string-literal escape: ' → ''. We use this for any JID we
// interpolate (always `<digits>@g.us`) and for JSON values (where
// JSON.stringify never emits ' so this is a defence-in-depth no-op
// today, but cheap).
function sqlEscape(s: string): string {
  return s.replace(/'/g, "''")
}

async function sqliteJson<T>(dbPath: string, sql: string): Promise<T[]> {
  const sqlite3 = findBin('sqlite3') ?? 'sqlite3'
  const r = await runCommand(sqlite3, ['-json', dbPath, sql])
  if (r.code !== 0) {
    throw new Error(
      r.stderr.trim().split('\n').slice(-2).join(' · ') ||
        `sqlite3 -json exited ${r.code}`
    )
  }
  const out = r.stdout.trim()
  if (!out) return []
  try {
    return JSON.parse(out) as T[]
  } catch (err) {
    throw new Error(`Failed to parse sqlite3 JSON output: ${(err as Error).message}`)
  }
}

async function sqliteExec(dbPath: string, sql: string): Promise<void> {
  const sqlite3 = findBin('sqlite3') ?? 'sqlite3'
  const r = await runCommand(sqlite3, [dbPath, sql])
  if (r.code !== 0) {
    throw new Error(
      r.stderr.trim().split('\n').slice(-2).join(' · ') ||
        `sqlite3 exited ${r.code}`
    )
  }
}

export interface MainGroupSummary {
  jid: string
  name: string
  exists: true
}

export async function readMainGroup(orchestratorRoot: string): Promise<
  | { found: true; group: MainGroupSummary }
  | { found: false; reason: string }
> {
  const dbPath = dbPathFor(orchestratorRoot)
  if (!fs.existsSync(dbPath)) {
    return { found: false, reason: `messages.db not found at ${dbPath}` }
  }
  try {
    const rows = await sqliteJson<MainGroupRow>(
      dbPath,
      'SELECT jid, name, container_config, is_main FROM registered_groups WHERE is_main = 1 LIMIT 1'
    )
    if (rows.length === 0) {
      return { found: false, reason: 'no main group registered yet — complete step 07 first' }
    }
    const r = rows[0]
    return { found: true, group: { jid: r.jid, name: r.name, exists: true } }
  } catch (err) {
    return { found: false, reason: (err as Error).message }
  }
}

export interface ApplyResult {
  success: boolean
  appliedToJid?: string
  appliedToName?: string
  sighup: boolean
  error?: string
}

export async function applyOpenMode(
  orchestratorRoot: string,
  enabled: boolean,
  budgetCents: number
): Promise<ApplyResult> {
  const dbPath = dbPathFor(orchestratorRoot)
  if (!fs.existsSync(dbPath)) {
    return {
      success: false,
      sighup: false,
      error: `messages.db not found at ${dbPath} — register a main group first.`
    }
  }

  // 1. Read the main group's current container_config (preserve any
  //    operator-side keys; merge openMode in).
  let rows: MainGroupRow[]
  try {
    rows = await sqliteJson<MainGroupRow>(
      dbPath,
      'SELECT jid, name, container_config, is_main FROM registered_groups WHERE is_main = 1 LIMIT 1'
    )
  } catch (err) {
    return { success: false, sighup: false, error: (err as Error).message }
  }
  if (rows.length === 0) {
    return {
      success: false,
      sighup: false,
      error: 'No main group registered yet. Complete the previous step first.'
    }
  }
  const main = rows[0]

  const parsed: Record<string, unknown> = main.container_config
    ? (JSON.parse(main.container_config) as Record<string, unknown>)
    : {}

  if (enabled) {
    parsed.openMode = {
      enabled: true,
      dailyBudgetCents: budgetCents,
      // Defaults match the CLI step exactly.
      rateLimit: { tokensPerHour: 30, burstMax: 5 }
    } satisfies OpenModeConfig
  } else {
    parsed.openMode = { enabled: false, dailyBudgetCents: budgetCents } satisfies OpenModeConfig
  }

  // 2. Write back. SQL-quote the JSON literal — JSON.stringify never
  //    emits ' inside its output so this is safe.
  const newConfig = JSON.stringify(parsed)
  try {
    await sqliteExec(
      dbPath,
      `UPDATE registered_groups SET container_config = '${sqlEscape(newConfig)}' WHERE jid = '${sqlEscape(main.jid)}'`
    )
  } catch (err) {
    return { success: false, sighup: false, error: (err as Error).message }
  }

  // 3. SIGHUP the orchestrator so it reloads registered_groups in-place.
  //    Best-effort: state still landed in the DB even if SIGHUP fails,
  //    so the operator just needs to restart the service.
  let sighup = false
  const health = await probeHealth(2000)
  if (health.reachable && health.nanoclaw.pid) {
    try {
      process.kill(health.nanoclaw.pid, 'SIGHUP')
      sighup = true
    } catch {
      sighup = false
    }
  }

  return {
    success: true,
    appliedToJid: main.jid,
    appliedToName: main.name,
    sighup
  }
}
