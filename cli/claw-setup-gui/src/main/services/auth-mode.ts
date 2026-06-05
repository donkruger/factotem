// Drive scripts/set-auth-mode.sh — the orchestrator's Anthropic auth-mode
// switch. The GUI uses this only for the OPTIONAL macOS keychain
// auto-rotation path: `oauth-workaround` loads the launchd watcher
// (com.nanoclaw.oauth-refresh) that re-syncs OneCLI from the macOS keychain;
// `api-key` unloads it. macOS only.
//
// The default subscription path (paste a `claude setup-token` token) does
// NOT use this — it registers a long-lived token directly via OneCLI and
// must NOT load the watcher, which would clobber the pasted token from the
// keychain on its next tick. See docs/OPERATIONS.md § Auth Mode.

import path from 'path'

import { runCommand } from './subprocess'

export interface SetAuthModeResult {
  success: boolean
  output?: string
  error?: string
}

/**
 * Run `scripts/set-auth-mode.sh <mode>` under the configured orchestrator
 * root. The script is `#!/bin/zsh` and executable, so we invoke it directly
 * (its shebang picks the interpreter). `runCommand` applies the augmented
 * PATH so `onecli`/`launchctl` resolve under the Electron launchd PATH.
 */
export async function setAuthMode(
  mode: 'oauth-workaround' | 'api-key',
  orchestratorRoot: string | null
): Promise<SetAuthModeResult> {
  if (process.platform !== 'darwin') {
    return { success: false, error: 'Keychain auto-rotation is macOS only.' }
  }
  if (!orchestratorRoot) {
    return {
      success: false,
      error: 'Orchestrator root unknown — cannot locate scripts/set-auth-mode.sh.'
    }
  }
  const script = path.join(orchestratorRoot, 'scripts', 'set-auth-mode.sh')
  const r = await runCommand(script, [mode])
  if (r.code !== 0) {
    return {
      success: false,
      output: r.stdout,
      error:
        r.stderr.trim().split('\n').slice(-4).join(' · ') ||
        `set-auth-mode.sh exited ${r.code}`
    }
  }
  return { success: true, output: r.stdout }
}
