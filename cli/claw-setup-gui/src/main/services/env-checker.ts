// Environment prerequisite checker.
//
// Walking-skeleton implementation. Long-term plan: import and call
// `step` from `cli/claw-setup/src/steps/01-check-prereqs.ts` directly,
// passing an ElectronUI adapter that implements the shared `UI`
// interface. That bridge is the architectural goal — see
// /Users/support/Documents/NanoClaw/UI-MIGRATION-FEASIBILITY.md.
//
// For the spike we re-implement the three core probes (Node, Docker,
// Tailscale) inline so the GUI works without a build step in the
// sibling claw-setup package. The probe semantics are identical
// (Node ≥20, `docker info` exit code, `tailscale status` exit code).

import fs from 'fs'
import path from 'path'
import os from 'os'
import { runCommand } from './subprocess'
import { findBin } from './path-utils'
import type { EnvCheckResult, ProbeResult } from '../../shared/types'

async function probeNode(): Promise<ProbeResult> {
  const nodeMajor = parseInt(process.versions.node.split('.')[0] ?? '0', 10)
  const ok = nodeMajor >= 20
  return {
    name: 'Node.js',
    ok,
    detail: `v${process.versions.node}${ok ? ' (≥20 OK)' : ' — need ≥20'}`,
    installUrl: 'https://nodejs.org/en/download',
    status: ok ? 'ok' : 'error'
  }
}

async function probeDocker(): Promise<ProbeResult> {
  const first = await runCommand('docker', ['info'])
  if (first.code === 0) {
    return {
      name: 'Docker',
      ok: true,
      detail: 'docker daemon reachable',
      installUrl: 'https://docker.com/products/docker-desktop',
      status: 'ok'
    }
  }

  // macOS-only auto-launch — mirrors 01-check-prereqs.ts behaviour but
  // we don't wait the full 60s in the walking skeleton because the
  // renderer is showing a spinner; we just classify and let the user
  // hit retry. Long-term: wire the polling progress through IPC events.
  if (process.platform === 'darwin') {
    if (fs.existsSync('/Applications/Docker.app')) {
      return {
        name: 'Docker',
        ok: false,
        detail:
          'Docker Desktop installed but daemon not running — open Docker.app and retry',
        installUrl: 'https://docker.com/products/docker-desktop',
        status: 'warn'
      }
    }
  }

  return {
    name: 'Docker',
    ok: false,
    detail: 'docker not installed or not on PATH',
    installUrl: 'https://docker.com/products/docker-desktop',
    status: 'error'
  }
}

async function probeTailscale(): Promise<ProbeResult> {
  // Try the augmented PATH first (subprocess.ts now includes
  // /usr/local/bin and /opt/homebrew/bin via path-utils).
  let result = await runCommand('tailscale', ['status'])

  // Fallback: Tailscale.app on macOS ships the CLI binary inside the
  // bundle, not on any PATH. findBin() knows the well-known paths.
  if (result.code !== 0) {
    const abs = findBin('tailscale')
    if (abs) {
      result = await runCommand(abs, ['status'])
    }
  }

  if (result.code === 0) {
    // First line of `tailscale status` is usually the local node — surface
    // it as the detail so the operator can see the GUI found the right one.
    const firstLine = result.stdout.split('\n')[0]?.trim() || 'tailscale up'
    return {
      name: 'Tailscale',
      ok: true,
      detail: firstLine.length > 80 ? firstLine.slice(0, 77) + '…' : firstLine,
      installUrl: 'https://tailscale.com/download',
      status: 'ok'
    }
  }
  return {
    name: 'Tailscale',
    ok: false,
    detail: 'tailscale not running or not installed',
    installUrl: 'https://tailscale.com/download',
    status: 'warn'
  }
}

async function probeOneCLIPresence(): Promise<ProbeResult> {
  // findBin handles both `which onecli` (via augmented PATH) and any
  // future .app-bundle entries we add. Doing the lookup ourselves
  // avoids the spawn round-trip of `which`.
  const bin = findBin('onecli')
  if (!bin) {
    return {
      name: 'OneCLI',
      ok: false,
      detail: 'onecli not on PATH — step 03 will install it',
      installUrl: 'https://onecli.dev',
      status: 'warn'
    }
  }
  const v = await runCommand(bin, ['--version'])
  return {
    name: 'OneCLI',
    ok: true,
    detail: v.stdout.trim().split('\n')[0] || 'onecli installed',
    installUrl: 'https://onecli.dev',
    status: 'ok'
  }
}

// Best-effort orchestrator-root detection. The CLI assumes process.cwd()
// is the orchestrator root (where store/auth/creds.json lives). The GUI
// can't make that assumption because Electron's cwd is the app bundle.
// We look in a few well-known locations.
function detectOrchestratorRoot(): string | null {
  const candidates = [
    path.join(os.homedir(), 'factotem'),
    path.join(os.homedir(), 'NanoClaw'),
    path.join(os.homedir(), 'nanoclaw'),
    path.join(os.homedir(), 'Documents', 'NanoClaw', 'nanoclaw')
  ]
  for (const dir of candidates) {
    if (
      fs.existsSync(path.join(dir, 'src', 'whatsapp-auth.ts')) ||
      fs.existsSync(path.join(dir, 'package.json'))
    ) {
      return dir
    }
  }
  return null
}

export async function checkEnv(): Promise<EnvCheckResult> {
  const probes = await Promise.all([
    probeNode(),
    probeDocker(),
    probeTailscale(),
    probeOneCLIPresence()
  ])
  return {
    probes,
    platform: process.platform,
    nodeVersion: process.versions.node,
    cwd: process.cwd(),
    orchestratorRoot: detectOrchestratorRoot()
  }
}
