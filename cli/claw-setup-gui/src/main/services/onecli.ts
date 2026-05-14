// OneCLI integration.
//
// Command shapes mirror cli/claw-setup/src/steps/03-configure-onecli.ts
// exactly. The CLI surface changed in OneCLI v1.7 and the wizard's
// previous shapes were guesses — these are the live ones used by
// Don's working machine.
//
// Flow:
//   1. Probe — gateway reachable at http://127.0.0.1:10254 ?
//   2. `onecli config set api-host http://127.0.0.1:10254` (idempotent)
//   3. `onecli auth status` (skip login if already authenticated)
//   4. `onecli auth login --api-key oc_...`
//   5. `onecli secrets list` (skip create if Anthropic secret exists)
//   6. `onecli secrets create --name Anthropic --type generic \
//          --value sk-ant-... --host-pattern api.anthropic.com \
//          --path-pattern /* --header-name x-api-key \
//          --value-format '{value}'`

import { runCommand } from './subprocess'
import { findBin } from './path-utils'

export const ONECLI_GATEWAY_URL = 'http://127.0.0.1:10254'
export const ONECLI_INSTALL_CMD =
  'curl -fsSL onecli.sh/install | sh && curl -fsSL onecli.sh/cli/install | sh'

export interface OneCLIState {
  installed: boolean
  version?: string
  gatewayUp: boolean
  authenticated: boolean
  anthropicSecretRegistered: boolean
}

async function probeGateway(): Promise<boolean> {
  const r = await runCommand('curl', [
    '-sf',
    '-o',
    '/dev/null',
    '-m',
    '2',
    `${ONECLI_GATEWAY_URL}/`
  ])
  return r.code === 0
}

async function probeAuthStatus(bin: string): Promise<boolean> {
  const r = await runCommand(bin, ['auth', 'status'])
  if (r.code !== 0) return false
  try {
    const parsed = JSON.parse(r.stdout) as { authenticated?: boolean }
    return parsed.authenticated === true
  } catch {
    return false
  }
}

async function probeAnthropicSecret(bin: string): Promise<boolean> {
  const r = await runCommand(bin, ['secrets', 'list'])
  if (r.code !== 0) return false
  try {
    const list = JSON.parse(r.stdout) as Array<{ name?: string; hostPattern?: string }>
    return (
      Array.isArray(list) &&
      list.some((s) => s.name === 'Anthropic' && s.hostPattern === 'api.anthropic.com')
    )
  } catch {
    return false
  }
}

export async function probeOneCLI(): Promise<OneCLIState> {
  const bin = findBin('onecli')
  const gatewayUp = await probeGateway()

  if (!bin) {
    return {
      installed: false,
      gatewayUp,
      authenticated: false,
      anthropicSecretRegistered: false
    }
  }

  const v = await runCommand(bin, ['--version'])
  const version = v.stdout.trim().split('\n')[0] || undefined

  // Auth + secrets probes only make sense if the gateway is reachable.
  if (!gatewayUp) {
    return {
      installed: true,
      version,
      gatewayUp: false,
      authenticated: false,
      anthropicSecretRegistered: false
    }
  }

  // Point the CLI at the local gateway before probing — idempotent.
  await runCommand(bin, ['config', 'set', 'api-host', ONECLI_GATEWAY_URL])

  const [authenticated, anthropicSecretRegistered] = await Promise.all([
    probeAuthStatus(bin),
    probeAnthropicSecret(bin)
  ])

  return {
    installed: true,
    version,
    gatewayUp: true,
    authenticated,
    anthropicSecretRegistered
  }
}

export async function authenticateOneCLI(apiKey: string): Promise<{
  success: boolean
  error?: string
}> {
  if (!apiKey.startsWith('oc_')) {
    return {
      success: false,
      error: 'OneCLI keys start with oc_. This looks like a different kind of key.'
    }
  }
  const bin = findBin('onecli')
  if (!bin) {
    return {
      success: false,
      error: 'onecli not found on PATH. Try re-installing.'
    }
  }
  // Ensure api-host is set before login (no-op if already set).
  await runCommand(bin, ['config', 'set', 'api-host', ONECLI_GATEWAY_URL])

  const r = await runCommand(bin, ['auth', 'login', '--api-key', apiKey])
  if (r.code !== 0) {
    return {
      success: false,
      error:
        (r.stderr.trim().split('\n').slice(-3).join(' · ') ||
          `onecli auth login exited ${r.code}`)
    }
  }
  return { success: true }
}

export async function registerAnthropicSecret(secretValue: string): Promise<{
  success: boolean
  error?: string
  alreadyExisted?: boolean
}> {
  const bin = findBin('onecli')
  if (!bin) {
    return { success: false, error: 'onecli not found on PATH.' }
  }

  // Skip create if the secret already exists with the right shape — matches
  // the CLI step's idempotency behaviour exactly.
  if (await probeAnthropicSecret(bin)) {
    return { success: true, alreadyExisted: true }
  }

  // The full eight-flag shape from cli/claw-setup/src/steps/03-configure-onecli.ts.
  // `--type generic` + explicit header config is what works against the real
  // Anthropic API — using `--type anthropic` is broken per the CLI's R3 lesson.
  const r = await runCommand(bin, [
    'secrets',
    'create',
    '--name',
    'Anthropic',
    '--type',
    'generic',
    '--value',
    secretValue,
    '--host-pattern',
    'api.anthropic.com',
    '--path-pattern',
    '/*',
    '--header-name',
    'x-api-key',
    '--value-format',
    '{value}'
  ])
  if (r.code !== 0) {
    return {
      success: false,
      error:
        (r.stderr.trim().split('\n').slice(-3).join(' · ') ||
          `onecli secrets create exited ${r.code}`)
    }
  }
  return { success: true }
}
