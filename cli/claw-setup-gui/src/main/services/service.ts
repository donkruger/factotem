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

const SERVICE_LABEL = 'com.nanoclaw'

function plistPath(): string {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `${SERVICE_LABEL}.plist`)
}

function renderPlist(orchestratorRoot: string): string {
  const nodePath = process.execPath // best-effort; user can swap if their Node differs
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

export async function unloadLaunchd(): Promise<{ success: boolean; error?: string }> {
  if (process.platform !== 'darwin') return { success: false, error: 'macOS only' }
  const uid = process.getuid?.() ?? 0
  const result = await runCommand('launchctl', ['bootout', `gui/${uid}/${SERVICE_LABEL}`])
  return result.code === 0 || /not loaded/i.test(result.stderr)
    ? { success: true }
    : { success: false, error: result.stderr.trim() }
}
