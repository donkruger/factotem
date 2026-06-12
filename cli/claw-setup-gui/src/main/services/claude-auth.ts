// Claude Code CLI detection for the subscription-auth path.
//
// The wizard's preferred Anthropic auth is a long-lived subscription token
// minted by `claude setup-token` (see CredentialsStep → SubscriptionForm).
// The "auto-run & capture" flow needs to know whether the `claude` binary is
// installed and where it lives — the renderer can't probe the filesystem, so
// it asks the main process via the `claude:detect` IPC.
//
// Minting itself is renderer-driven through the existing streaming
// `subprocess:*` IPC (start/onLine/onExit/cancel): the renderer spawns
// `<claudePath> setup-token`, streams progress, and parses the printed
// `sk-ant-oat…` token from the captured output. Keeping that in the renderer
// avoids a second bespoke streaming channel — see CLAUDE.md § IPC discipline.

import { findBin } from './path-utils'

export interface ClaudeDetectResult {
  installed: boolean
  /** Absolute path to the resolved `claude` binary, or null when not found. */
  path: string | null
}

/**
 * Locate the Claude Code CLI. Uses `findBin` (not `which`) so the macOS
 * launchd-PATH gotcha doesn't hide a real install — `findBin`'s augmented
 * PATH already covers `~/.local/bin` (the default `claude` install dir),
 * Homebrew, and nvm. See path-utils.ts.
 */
export function detectClaudeCli(): ClaudeDetectResult {
  const path = findBin('claude')
  return { installed: path !== null, path }
}
