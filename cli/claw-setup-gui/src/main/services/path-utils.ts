// macOS GUI PATH augmentation.
//
// Electron apps launched from Finder inherit launchd's minimal PATH
// (`/usr/bin:/bin:/usr/sbin:/sbin`) — which excludes /usr/local/bin
// (Homebrew Intel), /opt/homebrew/bin (Apple Silicon), and the binaries
// that live inside .app bundles. The result: `which tailscale` and
// `which onecli` come back empty even when the user clearly has them
// installed.
//
// The orchestrator has the same problem with launchd (see
// nanoclaw/CLAUDE.md § Troubleshooting). Pattern borrowed from
// EasyClaw's path-utils.ts: every subprocess we spawn gets an
// augmented PATH; binaries inside .app bundles also get well-known
// fallback paths.

import fs from 'fs'
import path from 'path'

const EXTRA_PATH_DIRS = [
  '/usr/local/bin',
  '/opt/homebrew/bin',
  '/usr/local/sbin',
  '/opt/homebrew/sbin',
  // OneCLI installer puts the binary here and does NOT add it to the
  // operator's PATH automatically — see cli/claw-setup/src/steps/
  // 03-configure-onecli.ts → resolveOnecliCmd.
  path.join(process.env['HOME'] ?? '', '.local/bin'),
  // NVM default install location — useful when the orchestrator was
  // installed via nvm in a shell session but the GUI launches outside
  // any shell context.
  path.join(process.env['HOME'] ?? '', '.nvm/versions/node/current/bin')
]

// Apps that ship a CLI binary inside their .app bundle. The wizard
// looks here when `which <name>` returns nothing — the binary exists,
// it just isn't symlinked onto the PATH.
const APP_BUNDLE_BINS: Record<string, string[]> = {
  tailscale: [
    '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
    '/Applications/Tailscale.app/Contents/MacOS/tailscale'
  ],
  docker: [
    '/Applications/Docker.app/Contents/Resources/bin/docker'
  ]
}

function augmentedPath(): string {
  const current = process.env['PATH'] ?? ''
  const parts = current.split(path.delimiter).filter(Boolean)
  for (const dir of EXTRA_PATH_DIRS) {
    if (!parts.includes(dir)) parts.push(dir)
  }
  return parts.join(path.delimiter)
}

// Return an env dict suitable for spawn() that includes our augmented PATH.
export function envWithPath(): NodeJS.ProcessEnv {
  return { ...process.env, PATH: augmentedPath() }
}

// Find a binary by name. Returns the first match it can verify on disk,
// or null. Order: well-known absolute paths inside .app bundles, then
// the augmented PATH.
export function findBin(name: string): string | null {
  // Check .app bundles first
  const bundlePaths = APP_BUNDLE_BINS[name.toLowerCase()] ?? []
  for (const p of bundlePaths) {
    if (fs.existsSync(p)) return p
  }
  // Then walk the augmented PATH
  for (const dir of augmentedPath().split(path.delimiter)) {
    if (!dir) continue
    const candidate = path.join(dir, name)
    if (fs.existsSync(candidate)) return candidate
    // Windows .exe variant
    if (process.platform === 'win32') {
      const exe = path.join(dir, `${name}.exe`)
      if (fs.existsSync(exe)) return exe
    }
  }
  return null
}
