// WhatsApp pairing — embedded flow.
//
// The orchestrator's auth script `nanoclaw/src/whatsapp-auth.ts` does
// something convenient: in addition to rendering an ASCII QR to stdout
// (via `qrcode-terminal`), it writes the RAW QR payload to
// `<root>/store/qr-data.txt` BEFORE rendering it, and writes the
// pairing status to `<root>/store/auth-status.txt` as it progresses.
// We poll those two files while the subprocess runs and stream their
// contents back to the renderer over IPC — same pattern as the
// container build's log streaming, just driven by file watches.
//
// Result: the GUI shows a real QR (rendered with the `qrcode` lib in
// the renderer) and a live status indicator. No CLI handoff needed for
// the default QR-scan flow. The pairing-code flow (which reads a phone
// number from stdin) is still a terminal handoff — that's a v2.

import fs from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import type { BrowserWindow } from 'electron'
import { spawn, type ChildProcess } from 'child_process'
import { envWithPath, findBin } from './path-utils'

const POLL_INTERVAL_MS = 250

interface Session {
  runId: string
  child: ChildProcess
  qrPath: string
  statusPath: string
  credsPath: string
  pollTimer: NodeJS.Timeout
  lastQr: string | null
  lastStatus: string | null
  done: boolean
}

const sessions = new Map<string, Session>()

function getMainWindow(): BrowserWindow | null {
  const { BrowserWindow: BW } = require('electron') as typeof import('electron')
  return BW.getAllWindows()[0] ?? null
}

function emit(channel: string, payload: unknown): void {
  const win = getMainWindow()
  if (!win || win.isDestroyed()) return
  win.webContents.send(channel, payload)
}

function readIfExists(p: string): string | null {
  try {
    return fs.readFileSync(p, 'utf8').trim()
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    return null
  }
}

function pollOnce(s: Session): void {
  if (s.done) return

  // QR data — written by the auth script the moment Baileys emits a QR.
  // The file gets unlinked when pairing succeeds, so we only watch for
  // its appearance and content changes (a fresh QR is issued every ~60s
  // if no scan happens).
  const qr = readIfExists(s.qrPath)
  if (qr && qr !== s.lastQr) {
    s.lastQr = qr
    emit(`whatsapp:qr:${s.runId}`, qr)
  }

  // Status — append-only-ish status string. Final values: authenticated,
  // already_authenticated, failed:*, pairing_code:<code>.
  const status = readIfExists(s.statusPath)
  if (status && status !== s.lastStatus) {
    s.lastStatus = status
    if (status === 'authenticated' || status === 'already_authenticated') {
      // Enrich with the linked number (parsed from creds.json) so the
      // success panel can show it, e.g. `authenticated:27821234567`.
      const num = readLinkedNumber(s.credsPath)
      emit(`whatsapp:status:${s.runId}`, num ? `${status}:${num}` : status)
      s.done = true
    } else {
      emit(`whatsapp:status:${s.runId}`, status)
      if (status.startsWith('failed:')) {
        // Terminal state — stop polling. The subprocess will exit on its own.
        s.done = true
      }
    }
  }

  // Defensive: also check for creds.json appearing. The script writes
  // STATUS_FILE=authenticated and then unlinks QR_FILE, but on some
  // edge cases (stream-error retry path) the status file may lag.
  if (!s.done && fs.existsSync(s.credsPath)) {
    s.done = true
    const num = readLinkedNumber(s.credsPath)
    emit(`whatsapp:status:${s.runId}`, num ? `authenticated:${num}` : 'authenticated')
  }
}

export interface StartResult {
  runId: string
  qrPath: string
  statusPath: string
  credsPath: string
}

/**
 * Optional per-pairing arguments (v1.2.1-finish-blueprint § 2). When
 * absent, the function behaves byte-identically to v1.0: pair the
 * deployment's shared WhatsApp account into `store/auth/`. When set,
 * the auth script's NANOCLAW_AUTH_DIR + NANOCLAW_PAIRING_ID env vars
 * route to a per-pairing auth directory and suffixed hand-off files
 * so multiple concurrent pair runs (rare but possible) don't
 * collide.
 */
export interface WhatsAppAuthOpts {
  /** Pairing id — suffixes the QR + status hand-off files. */
  pairingId?: string
  /**
   * Absolute auth directory. The auth script writes Baileys
   * creds.json here. When omitted, falls back to `store/auth/`
   * relative to orchestratorRoot.
   */
  authDir?: string
  /**
   * 'qr' (default) renders a scannable QR. 'pairing-code' asks Baileys
   * for a phone-number pairing code (requires `phone`) and writes it to
   * the status file as `pairing_code:<code>` — no terminal stdin needed.
   */
  method?: 'qr' | 'pairing-code'
  /** Digits-only phone number (no `+`/spaces), required for pairing-code. */
  phone?: string
  /**
   * Wipe the auth directory before starting. Used on a retry or when
   * switching method, so a previous failed/timed-out attempt's partial
   * `creds.json` can't wedge the new attempt (ben-log 2026-06-12). NOT
   * set on the first attempt, so the script's `already_authenticated`
   * short-circuit for valid existing creds still fires.
   */
  reset?: boolean
}

/**
 * Best-effort read of the linked phone number from a Baileys creds.json.
 * `me.id` looks like `27821234567:12@s.whatsapp.net`; return the leading
 * digits so the success panel can show "Linked as +27821234567".
 */
function readLinkedNumber(credsPath: string): string | null {
  try {
    const creds = JSON.parse(fs.readFileSync(credsPath, 'utf8'))
    const id: unknown = creds?.me?.id
    if (typeof id !== 'string') return null
    const m = id.match(/^(\d+)/)
    return m ? m[1] : null
  } catch {
    return null
  }
}

export function startWhatsAppAuth(
  orchestratorRoot: string,
  opts: WhatsAppAuthOpts = {}
): StartResult {
  const runId = randomUUID()
  const suffix = opts.pairingId ? `-${opts.pairingId}` : ''
  const qrPath = path.join(orchestratorRoot, 'store', `qr-data${suffix}.txt`)
  const statusPath = path.join(
    orchestratorRoot,
    'store',
    `auth-status${suffix}.txt`
  )
  const authDir =
    opts.authDir ?? path.join(orchestratorRoot, 'store', 'auth')
  const credsPath = path.join(authDir, 'creds.json')

  // Clean up stale files from previous runs so polling doesn't
  // immediately emit a leftover authenticated/QR.
  for (const p of [qrPath, statusPath]) {
    try {
      fs.unlinkSync(p)
    } catch {
      /* not present — ignore */
    }
  }

  // On a retry / method switch, wipe the auth dir so a previous failed
  // attempt's partial creds.json can't wedge this one (Baileys would see
  // half-registered creds and never issue a fresh QR/code). NOT done on
  // the first attempt — that would defeat the script's
  // `already_authenticated` short-circuit for valid existing creds.
  if (opts.reset) {
    try {
      fs.rmSync(authDir, { recursive: true, force: true })
    } catch {
      /* not present — ignore */
    }
  }

  // Pass per-pairing context to the auth script via env. Absent vars
  // = legacy behaviour (the script falls back to ./store/auth/ +
  // unsuffixed hand-off files).
  const env: NodeJS.ProcessEnv = {
    ...envWithPath(),
    ...(opts.pairingId ? { NANOCLAW_PAIRING_ID: opts.pairingId } : {}),
    ...(opts.authDir ? { NANOCLAW_AUTH_DIR: opts.authDir } : {})
  }

  // pairing-code mode passes --phone so the script never blocks on stdin
  // (the reason it used to require a terminal). Default is the QR flow.
  const scriptArgs = ['tsx', 'src/whatsapp-auth.ts']
  if (opts.method === 'pairing-code' && opts.phone) {
    scriptArgs.push('--pairing-code', '--phone', opts.phone)
  }

  // findBin so a Finder-launched app (minimal launchd PATH) still resolves
  // npx; envWithPath augments the child PATH for the tsx/node it spawns.
  const child = spawn(findBin('npx') ?? 'npx', scriptArgs, {
    cwd: orchestratorRoot,
    env,
    shell: false
  })

  // Also stream stdout/stderr for the LogViewer behind the QR.
  child.stdout?.on('data', (d: Buffer) =>
    emit(`whatsapp:line:${runId}`, d.toString())
  )
  child.stderr?.on('data', (d: Buffer) =>
    emit(`whatsapp:line:${runId}`, d.toString())
  )

  const session: Session = {
    runId,
    child,
    qrPath,
    statusPath,
    credsPath,
    pollTimer: setInterval(() => pollOnce(session), POLL_INTERVAL_MS),
    lastQr: null,
    lastStatus: null,
    done: false
  }
  sessions.set(runId, session)

  child.on('error', (err) => {
    emit(`whatsapp:line:${runId}`, `[spawn error] ${err.message}\n`)
  })
  child.on('close', (code) => {
    // Final poll to catch any last writes.
    pollOnce(session)
    emit(`whatsapp:exit:${runId}`, { code: code ?? -1 })
    clearInterval(session.pollTimer)
    sessions.delete(runId)
  })

  return { runId, qrPath, statusPath, credsPath }
}

export function cancelWhatsAppAuth(runId: string): boolean {
  const s = sessions.get(runId)
  if (!s) return false
  s.child.kill('SIGTERM')
  clearInterval(s.pollTimer)
  return true
}
