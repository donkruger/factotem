// launchd plist generation + bootstrap.
//
// Mirrors cli/claw-setup/src/steps/09-install-launchd.ts. macOS-only;
// Linux and WSL paths fall back to instructing the user to install
// the orchestrator's systemd unit manually (the CLI step handles
// systemd through `nanoclaw/setup/service.ts` — we honest-handoff
// for now and port that path later if Linux is in scope).

import fs from 'fs'
import os from 'os'
import path from 'path'
import { runCommand } from './subprocess'
import { findBin } from './path-utils'
import type { ServiceStartResult } from '../../shared/types'

const SERVICE_LABEL = 'com.nanoclaw'

function plistPath(): string {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `${SERVICE_LABEL}.plist`)
}

/**
 * Resolve a REAL Node binary for the launchd plist.
 *
 * `process.execPath` is the Electron binary when the wizard runs as a GUI
 * app — and a plist that runs the orchestrator under Electron loads its
 * native modules (better-sqlite3) against Electron's ABI
 * (NODE_MODULE_VERSION), which mismatches the system Node those modules
 * were built for. The service then crash-loops on startup with
 * "compiled against a different Node.js version" (ben-log 2026-06-09 —
 * this exact bug took Ben down). Always resolve a real Node on PATH;
 * only fall back to process.execPath when this process is itself plain
 * Node (CLI / dev runs, not Electron).
 */
function resolveNodePath(): string {
  const onPath = findBin('node')
  if (onPath) return onPath
  const isElectron = !!(process.versions as { electron?: string }).electron
  if (!isElectron) return process.execPath
  for (const p of ['/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node']) {
    if (fs.existsSync(p)) return p
  }
  return 'node'
}

function renderPlist(orchestratorRoot: string): string {
  const nodePath = resolveNodePath()
  const dist = path.join(orchestratorRoot, 'dist', 'index.js')
  const logDir = path.join(orchestratorRoot, '.logs')
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${SERVICE_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
      <string>${nodePath}</string>
      <string>${dist}</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${orchestratorRoot}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${path.join(logDir, 'nanoclaw.out.log')}</string>
    <key>StandardErrorPath</key>
    <string>${path.join(logDir, 'nanoclaw.err.log')}</string>
    <key>EnvironmentVariables</key>
    <dict>
      <key>PATH</key>
      <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    </dict>
  </dict>
</plist>
`
}

export async function isLaunchdLoaded(): Promise<boolean> {
  if (process.platform !== 'darwin') return false
  const uid = process.getuid?.() ?? 0
  const result = await runCommand('launchctl', ['print', `gui/${uid}/${SERVICE_LABEL}`])
  return result.code === 0
}

export async function installLaunchd(orchestratorRoot: string): Promise<{
  success: boolean
  plistPath: string
  bootstrapped: boolean
  error?: string
}> {
  if (process.platform !== 'darwin') {
    return {
      success: false,
      plistPath: '',
      bootstrapped: false,
      error: `Service install via the GUI is currently macOS-only. On Linux, run \`npm run claw-setup -- --resume\` to install the systemd unit; the wizard will pick up step 09.`
    }
  }

  const dest = plistPath()
  try {
    await fs.promises.mkdir(path.dirname(dest), { recursive: true })
    await fs.promises.writeFile(dest, renderPlist(orchestratorRoot), { mode: 0o644 })
  } catch (err) {
    return {
      success: false,
      plistPath: dest,
      bootstrapped: false,
      error: `Failed to write plist: ${(err as Error).message}`
    }
  }

  const uid = process.getuid?.() ?? 0
  const bootstrap = await runCommand('launchctl', ['bootstrap', `gui/${uid}`, dest])
  if (bootstrap.code !== 0 && !/already loaded/i.test(bootstrap.stderr)) {
    return {
      success: false,
      plistPath: dest,
      bootstrapped: false,
      error: bootstrap.stderr.trim() || `launchctl bootstrap exited ${bootstrap.code}`
    }
  }

  return { success: true, plistPath: dest, bootstrapped: true }
}

// Start (or restart) the already-installed orchestrator service.
//
// Used by the in-wizard "service down" remediation (see
// renderer/components/OrchestratorUnreachable.tsx): when a step that
// depends on the orchestrator's HTTP API finds it unreachable, the
// operator can start it from the wizard instead of dropping to a
// terminal. `kickstart -k` starts a loaded-but-stopped service and
// restarts a running one, so it's safe to call regardless of current
// state — as long as the launchd label exists. If it doesn't, the
// service was never installed and the caller should route the operator
// back through setup rather than imply a start is possible.
export async function startOrchestrator(): Promise<ServiceStartResult> {
  if (process.platform !== 'darwin') {
    return {
      success: false,
      reason: 'unsupported',
      error:
        'Auto-start is macOS-only for now. On Linux, start the systemd unit (or run `npm start` in the orchestrator root).'
    }
  }
  const uid = process.getuid?.() ?? 0

  // Already loaded → kickstart (-k restarts a running one, starts a
  // loaded-but-stopped one).
  if (await isLaunchdLoaded()) {
    const result = await runCommand('launchctl', [
      'kickstart',
      '-k',
      `gui/${uid}/${SERVICE_LABEL}`
    ])
    if (result.code !== 0) {
      return {
        success: false,
        reason: 'error',
        error: result.stderr.trim() || `launchctl kickstart exited ${result.code}`
      }
    }
    return { success: true, reason: 'started' }
  }

  // Not loaded. If the plist exists on disk we can (re)bootstrap it —
  // this is the path after the re-pair flow unloads the crash-looping
  // service: "Start the orchestrator" must be able to bring it back.
  const dest = plistPath()
  if (!fs.existsSync(dest)) {
    return {
      success: false,
      reason: 'not-installed',
      error:
        'No NanoClaw launchd service is installed yet. Finish the setup wizard (or run `npm run claw-setup`) before starting the orchestrator.'
    }
  }
  const bootstrap = await runCommand('launchctl', ['bootstrap', `gui/${uid}`, dest])
  if (bootstrap.code !== 0 && !/already (loaded|bootstrapped)/i.test(bootstrap.stderr)) {
    return {
      success: false,
      reason: 'error',
      error:
        bootstrap.stderr.trim() || `launchctl bootstrap exited ${bootstrap.code}`
    }
  }
  // RunAtLoad starts it on bootstrap; kickstart as a belt-and-braces in
  // case it was loaded-but-stopped between the probe and the bootstrap.
  await runCommand('launchctl', ['kickstart', '-k', `gui/${uid}/${SERVICE_LABEL}`])
  return { success: true, reason: 'started' }
}

export async function unloadLaunchd(): Promise<{ success: boolean; error?: string }> {
  if (process.platform !== 'darwin') return { success: false, error: 'macOS only' }
  const uid = process.getuid?.() ?? 0
  const result = await runCommand('launchctl', ['bootout', `gui/${uid}/${SERVICE_LABEL}`])
  return result.code === 0 || /not loaded/i.test(result.stderr)
    ? { success: true }
    : { success: false, error: result.stderr.trim() }
}
