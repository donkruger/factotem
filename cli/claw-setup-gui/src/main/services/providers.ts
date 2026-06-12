// Generic provider integration — replaces the Anthropic-only OneCLI
// service for any new provider work. Reads `setup/providers.json` (PR 2)
// to know each provider's auth_kind, models endpoint, and OneCLI shape.
//
// Three operations:
//   1. listProviders() — return the registry to the renderer
//   2. probeKey(protocol, apiKey) — hit the provider's models_endpoint
//      with the entered credentials. Returns success or a diagnosed
//      error class. Operators never finish setup against a wrong key.
//   3. createCredential(protocol, apiKey) — uses the registry's OneCLI
//      config (host_pattern, header_name, value_format) to create the
//      provider's named secret.
//
// See docs/PROVIDER_PLAYBOOK.md § 4.2 (Wizard contract) + § 4.4
// (OneCLI contract) + docs/implementation/gemini-blueprint.md § 5
// (Phase C).

import fs from 'fs'
import os from 'os'
import path from 'path'
import { runCommand } from './subprocess'
import { findBin } from './path-utils'

/**
 * Anthropic credential injection depends on the credential TYPE:
 *   - API key (sk-ant-api…): Anthropic accepts it on `x-api-key`.
 *   - Subscription/OAuth token (sk-ant-oat…): Anthropic REJECTS `x-api-key`
 *     ("invalid x-api-key") and only accepts `Authorization: Bearer`.
 * The registry's static `onecli` config can't capture this, so for
 * Anthropic we pick the injection shape from the value at registration
 * time. (ben-log 2026-06-09: the previously-documented "x-api-key works
 * for both" is no longer true — Anthropic changed OAuth handling.)
 */
function isAnthropicSubscriptionToken(value: string): boolean {
  return value.startsWith('sk-ant-oat')
}

interface OneCLIInjection {
  headerName: string
  valueFormat: string
}

function anthropicInjectionFor(value: string): OneCLIInjection {
  return isAnthropicSubscriptionToken(value)
    ? { headerName: 'Authorization', valueFormat: 'Bearer {value}' }
    : { headerName: 'x-api-key', valueFormat: '{value}' }
}

/**
 * Persist the Anthropic auth-mode marker the orchestrator reads at
 * container-spawn time (see nanoclaw/src/container-runner.ts and
 * config.AUTH_MODE_PATH). `subscription` makes the runtime route the
 * container via ANTHROPIC_AUTH_TOKEN (Authorization: Bearer); `api-key`
 * keeps the x-api-key path. The keychain-rotation path writes
 * `oauth-workaround` via scripts/set-auth-mode.sh and is left untouched.
 */
function writeAuthModeMarker(mode: 'api-key' | 'subscription'): void {
  try {
    const dir = path.join(os.homedir(), '.config', 'nanoclaw')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'auth-mode'), `${mode}\n`)
  } catch {
    /* non-fatal: the secret is still registered; routing falls back to api-key */
  }
}

// Resolve providers.json relative to the orchestrator root the wizard is
// configured to manage. The wizard discovers this root via env.check; we
// fall back to the bundled file if needed. Most operators have the repo
// cloned to ~/code/nanoclaw or similar — the wizard reads its own
// __dirname-relative copy if NANOCLAW_ROOT isn't set.
const PROVIDERS_JSON_REL_PATH = 'setup/providers.json'

export interface ProviderRegistryEntry {
  name: string
  tagline: string
  wire_protocol: 'anthropic' | 'openai-compatible'
  base_url: string
  auth_kind: 'api-key' | 'none' | 'oauth'
  default_model: string
  models_endpoint: string
  key_signup_url?: string
  key_format_hint?: string
  onecli: {
    name: string
    host_pattern: string
    header_name: string
    value_format: string
  } | null
  // Optional non-auth headers the models-endpoint probe requires
  // (e.g. anthropic-version on Anthropic). Runtime SDKs set these
  // automatically inside the container; the wizard's curl probe has
  // to send them explicitly.
  probe_headers?: Record<string, string>
  // Present only on providers that can route through a consumer
  // subscription (Anthropic/Claude). Mirror of the shared-types shape.
  subscription_auth?: {
    label: string
    tagline: string
    setup_command: string
    token_format_hint: string
    docs_note: string
    supports_keychain_rotation?: boolean
  }
  capabilities: {
    tool_use: string
    vision: boolean
    computer_use: boolean
    prompt_caching: boolean
    long_context: boolean
    local: boolean
  }
  container_image: string
  ships_in: string
  cost_hint: string
}

export interface ProviderRegistry {
  [protocol: string]: ProviderRegistryEntry
}

let cachedRegistry: ProviderRegistry | null = null

/**
 * Resolve providers.json. Tries the orchestrator root (from env or hint)
 * first; falls back to the wizard's bundled copy.
 *
 * For dev runs (`npm run dev` in the GUI) __dirname points at the
 * source tree; for built apps it points inside the asar bundle. We
 * accept either.
 */
function resolveProvidersJsonPath(orchestratorRoot?: string | null): string {
  const candidates: string[] = []
  if (orchestratorRoot) {
    candidates.push(path.join(orchestratorRoot, PROVIDERS_JSON_REL_PATH))
  }
  // Search up from the GUI's own location — covers the dev case where
  // the GUI is at nanoclaw/cli/claw-setup-gui/.
  // dist path: /path/to/.../out/main/index.js
  // src path: /path/to/.../src/main/services/providers.ts (under tsx)
  const here = __dirname
  let up = here
  for (let i = 0; i < 8; i++) {
    candidates.push(path.join(up, PROVIDERS_JSON_REL_PATH))
    const parent = path.dirname(up)
    if (parent === up) break
    up = parent
  }
  for (const c of candidates) {
    if (fs.existsSync(c)) return c
  }
  throw new Error(
    `providers.json not found. Searched: ${candidates.slice(0, 5).join(', ')}…`
  )
}

export function loadProviderRegistry(orchestratorRoot?: string | null): ProviderRegistry {
  if (cachedRegistry) return cachedRegistry
  const file = resolveProvidersJsonPath(orchestratorRoot)
  const raw = fs.readFileSync(file, 'utf8')
  const parsed = JSON.parse(raw) as Record<string, unknown>
  const out: ProviderRegistry = {}
  for (const [key, value] of Object.entries(parsed)) {
    if (key.startsWith('_') || key.startsWith('$')) continue
    out[key] = value as ProviderRegistryEntry
  }
  cachedRegistry = out
  return out
}

export function listProviders(
  orchestratorRoot?: string | null
): ProviderRegistry {
  return loadProviderRegistry(orchestratorRoot)
}

export interface ProbeKeyResult {
  ok: boolean
  /** Operator-facing diagnostic message. Always present. */
  message: string
  /** Models discovered, when ok = true. */
  modelCount?: number
  /** Error class from PROVIDER_PLAYBOOK § 7.5. */
  error_class?:
    | 'auth.invalid_key'
    | 'provider.unreachable'
    | 'quota.rate_limited'
    | 'unknown'
}

/**
 * Hit the provider's models endpoint with the entered API key to verify
 * it authenticates and the network path works. Operators see a diagnosed
 * failure ("That key didn't authenticate" vs "Can't reach <provider>")
 * not a stack trace.
 */
export async function probeKey(
  protocol: string,
  apiKey: string,
  orchestratorRoot?: string | null
): Promise<ProbeKeyResult> {
  const registry = loadProviderRegistry(orchestratorRoot)
  const entry = registry[protocol]
  if (!entry) {
    return {
      ok: false,
      message: `Unknown provider: ${protocol}`,
      error_class: 'unknown'
    }
  }

  if (entry.auth_kind === 'none') {
    // Local provider — probe the models endpoint with no auth header.
    return await probeNoAuth(entry)
  }

  // Cloud providers send the credential in the format the registry
  // specifies. {value} is substituted with the entered key.
  if (!entry.onecli) {
    return {
      ok: false,
      message: `Provider ${protocol} has no onecli config — can't probe`,
      error_class: 'unknown'
    }
  }
  const headerName = entry.onecli.header_name
  const headerValue = entry.onecli.value_format.replace('{value}', apiKey)
  return await probeWithHeader(entry, headerName, headerValue)
}

async function probeWithHeader(
  entry: ProviderRegistryEntry,
  headerName: string,
  headerValue: string
): Promise<ProbeKeyResult> {
  // curl is preferred over fetch here — runs in the main process where
  // network is unrestricted, and the operator's wizard already shells
  // out to curl for OneCLI probes. Identical observability.
  //
  // Some providers reject a request that's missing a provider-specific
  // header even when the auth header is correct — Anthropic's
  // /v1/models returns HTTP 400 ("anthropic-version: header is
  // required") unless we send `anthropic-version: 2023-06-01`. The
  // runtime SDK inside the agent container sets these automatically;
  // the wizard's probe has to send them explicitly. `probe_headers`
  // on the registry entry lists the extras; absent = no extras (the
  // OpenAI-compatible providers don't need any).
  const extraHeaderArgs: string[] = []
  if (entry.probe_headers) {
    for (const [name, value] of Object.entries(entry.probe_headers)) {
      extraHeaderArgs.push('-H', `${name}: ${value}`)
    }
  }
  const r = await runCommand('curl', [
    '-sS',
    '-o',
    '-',
    '-w',
    '\nHTTP_STATUS:%{http_code}',
    '-m',
    '10',
    '-H',
    `${headerName}: ${headerValue}`,
    ...extraHeaderArgs,
    entry.models_endpoint
  ])
  return interpretProbeResult(entry, r)
}

async function probeNoAuth(entry: ProviderRegistryEntry): Promise<ProbeKeyResult> {
  const r = await runCommand('curl', [
    '-sS',
    '-o',
    '-',
    '-w',
    '\nHTTP_STATUS:%{http_code}',
    '-m',
    '5',
    entry.models_endpoint
  ])
  if (r.code !== 0) {
    return {
      ok: false,
      message: `${entry.name} didn't respond. Is the local daemon running?`,
      error_class: 'provider.unreachable'
    }
  }
  // Count models if the response is parseable. Different local providers
  // return different shapes — Ollama returns {models:[…]}, OpenAI-compat
  // returns {data:[…]}.
  const body = stripHttpStatusFooter(r.stdout)
  let modelCount: number | undefined
  try {
    const parsed = JSON.parse(body) as { models?: unknown[]; data?: unknown[] }
    if (Array.isArray(parsed.models)) modelCount = parsed.models.length
    else if (Array.isArray(parsed.data)) modelCount = parsed.data.length
  } catch {
    /* not JSON — that's ok, the probe still succeeded */
  }
  return {
    ok: true,
    message: modelCount
      ? `${entry.name} is reachable — found ${modelCount} models.`
      : `${entry.name} is reachable.`,
    modelCount
  }
}

function stripHttpStatusFooter(s: string): string {
  const idx = s.lastIndexOf('\nHTTP_STATUS:')
  return idx === -1 ? s : s.slice(0, idx)
}

function interpretProbeResult(
  entry: ProviderRegistryEntry,
  r: { code: number; stdout: string; stderr: string }
): ProbeKeyResult {
  if (r.code !== 0) {
    return {
      ok: false,
      message: `Can't reach ${entry.name}. Check your internet connection or ${entry.name}'s status page.`,
      error_class: 'provider.unreachable'
    }
  }
  // Pull the HTTP status off the tail of curl's output.
  const match = r.stdout.match(/\nHTTP_STATUS:(\d{3})/)
  const status = match ? parseInt(match[1], 10) : 0
  const body = stripHttpStatusFooter(r.stdout)

  if (status >= 200 && status < 300) {
    let modelCount: number | undefined
    try {
      const parsed = JSON.parse(body) as { data?: unknown[]; models?: unknown[] }
      if (Array.isArray(parsed.data)) modelCount = parsed.data.length
      else if (Array.isArray(parsed.models)) modelCount = parsed.models.length
    } catch {
      /* response wasn't JSON — still authenticated */
    }
    return {
      ok: true,
      message: modelCount
        ? `Connected to ${entry.name} — found ${modelCount} models. Defaulting to ${entry.default_model}.`
        : `Connected to ${entry.name}. Defaulting to ${entry.default_model}.`,
      modelCount
    }
  }
  if (status === 401 || status === 403) {
    return {
      ok: false,
      message: `That key didn't authenticate. Common causes: typo, key revoked, project deleted.`,
      error_class: 'auth.invalid_key'
    }
  }
  if (status === 429) {
    return {
      ok: false,
      message: `${entry.name} rate-limited the verification request. Wait a moment and try again.`,
      error_class: 'quota.rate_limited'
    }
  }
  if (status === 0) {
    return {
      ok: false,
      message: `Can't reach ${entry.name}. Check your internet connection.`,
      error_class: 'provider.unreachable'
    }
  }
  return {
    ok: false,
    message: `${entry.name} returned HTTP ${status}. ${truncate(body, 200)}`,
    error_class: 'unknown'
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s
}

export interface CreateCredentialResult {
  success: boolean
  alreadyExisted?: boolean
  error?: string
}

/**
 * Register the provider's secret in OneCLI. Uses the registry's
 * onecli.{host_pattern, header_name, value_format} so adding the 9th
 * provider is a JSON edit, not a code change.
 *
 * Local providers (auth_kind = 'none', onecli = null) short-circuit
 * with success — no OneCLI secret needed.
 */
export async function createCredential(
  protocol: string,
  apiKey: string,
  orchestratorRoot?: string | null
): Promise<CreateCredentialResult> {
  const registry = loadProviderRegistry(orchestratorRoot)
  const entry = registry[protocol]
  if (!entry) {
    return { success: false, error: `Unknown provider: ${protocol}` }
  }
  if (!entry.onecli) {
    // Local provider — no OneCLI secret required.
    return { success: true }
  }

  const bin = findBin('onecli')
  if (!bin) {
    return { success: false, error: 'onecli not found on PATH.' }
  }

  // Skip create if the secret already exists with the matching host
  // pattern — same idempotency as the legacy onecli.ts shape.
  if (await probeSecretExists(bin, entry.onecli.name, entry.onecli.host_pattern)) {
    return { success: true, alreadyExisted: true }
  }

  // For Anthropic, the injection shape depends on the credential type
  // (API key → x-api-key; OAuth/subscription token → Authorization: Bearer).
  const injection =
    protocol === 'anthropic'
      ? anthropicInjectionFor(apiKey)
      : { headerName: entry.onecli.header_name, valueFormat: entry.onecli.value_format }

  const r = await runCommand(bin, [
    'secrets',
    'create',
    '--name',
    entry.onecli.name,
    '--type',
    'generic',
    '--value',
    apiKey,
    '--host-pattern',
    entry.onecli.host_pattern,
    '--path-pattern',
    '/*',
    '--header-name',
    injection.headerName,
    '--value-format',
    injection.valueFormat
  ])
  if (r.code !== 0) {
    return {
      success: false,
      error:
        r.stderr.trim().split('\n').slice(-3).join(' · ') ||
        `onecli secrets create exited ${r.code}`
    }
  }
  if (protocol === 'anthropic') {
    writeAuthModeMarker(isAnthropicSubscriptionToken(apiKey) ? 'subscription' : 'api-key')
  }
  return { success: true }
}

async function probeSecretExists(
  bin: string,
  name: string,
  hostPattern: string
): Promise<boolean> {
  const r = await runCommand(bin, ['secrets', 'list'])
  if (r.code !== 0) return false
  try {
    const list = JSON.parse(r.stdout) as Array<{ name?: string; hostPattern?: string }>
    return (
      Array.isArray(list) &&
      list.some((s) => s.name === name && s.hostPattern === hostPattern)
    )
  } catch {
    return false
  }
}

/**
 * Resolve the OneCLI secret id for a (name, hostPattern) pair so we can
 * `secrets update --id`. The exact JSON key OneCLI uses for the id isn't
 * documented here, so accept the common spellings. Returns null when the
 * secret is absent or its id can't be determined.
 */
async function findSecretId(
  bin: string,
  name: string,
  hostPattern: string
): Promise<string | null> {
  const r = await runCommand(bin, ['secrets', 'list'])
  if (r.code !== 0) return null
  try {
    const list = JSON.parse(r.stdout) as Array<{
      name?: string
      hostPattern?: string
      id?: string
      secretId?: string
      uuid?: string
    }>
    if (!Array.isArray(list)) return null
    const hit = list.find((s) => s.name === name && s.hostPattern === hostPattern)
    if (!hit) return null
    return hit.id ?? hit.secretId ?? hit.uuid ?? null
  } catch {
    return null
  }
}

/**
 * Register OR overwrite the provider's OneCLI secret value.
 *
 * Unlike createCredential (which no-ops when the named secret already
 * exists), this UPDATES the value of an existing secret — required when an
 * operator switches the Anthropic secret between an API key and a
 * subscription token, or rotates either. The injection config (header,
 * value_format, host pattern) comes from the registry on *create* and is
 * left untouched on *update* (only `--value` changes), matching
 * scripts/set-auth-mode.sh push_secret.
 *
 * For Anthropic both an `sk-ant-api…` key and an `sk-ant-oat…` subscription
 * token share the same `x-api-key` injection (the path the orchestrator's
 * OneCLI proxy already uses for both). Switching that header to
 * `Authorization: Bearer` for OAuth (plan item B2) is a verified follow-up.
 */
export async function updateOrCreateCredential(
  protocol: string,
  value: string,
  orchestratorRoot?: string | null
): Promise<CreateCredentialResult> {
  const registry = loadProviderRegistry(orchestratorRoot)
  const entry = registry[protocol]
  if (!entry) {
    return { success: false, error: `Unknown provider: ${protocol}` }
  }
  if (!entry.onecli) {
    // Local provider — no OneCLI secret required.
    return { success: true }
  }

  const bin = findBin('onecli')
  if (!bin) {
    return { success: false, error: 'onecli not found on PATH.' }
  }

  // For Anthropic the injection shape is value-dependent (API key →
  // x-api-key; OAuth/subscription token → Authorization: Bearer). We must
  // therefore update header-name/value-format too — not just the value —
  // when an operator switches between an API key and a subscription token.
  const injection =
    protocol === 'anthropic'
      ? anthropicInjectionFor(value)
      : { headerName: entry.onecli.header_name, valueFormat: entry.onecli.value_format }

  const id = await findSecretId(bin, entry.onecli.name, entry.onecli.host_pattern)
  if (id) {
    const r = await runCommand(bin, [
      'secrets',
      'update',
      '--id',
      id,
      '--value',
      value,
      '--header-name',
      injection.headerName,
      '--value-format',
      injection.valueFormat
    ])
    if (r.code !== 0) {
      return {
        success: false,
        error:
          r.stderr.trim().split('\n').slice(-3).join(' · ') ||
          `onecli secrets update exited ${r.code}`
      }
    }
    if (protocol === 'anthropic') {
      writeAuthModeMarker(isAnthropicSubscriptionToken(value) ? 'subscription' : 'api-key')
    }
    return { success: true, alreadyExisted: true }
  }

  // No existing secret — create it with the resolved injection config.
  const r = await runCommand(bin, [
    'secrets',
    'create',
    '--name',
    entry.onecli.name,
    '--type',
    'generic',
    '--value',
    value,
    '--host-pattern',
    entry.onecli.host_pattern,
    '--path-pattern',
    '/*',
    '--header-name',
    injection.headerName,
    '--value-format',
    injection.valueFormat
  ])
  if (r.code !== 0) {
    return {
      success: false,
      error:
        r.stderr.trim().split('\n').slice(-3).join(' · ') ||
        `onecli secrets create exited ${r.code}`
    }
  }
  if (protocol === 'anthropic') {
    writeAuthModeMarker(isAnthropicSubscriptionToken(value) ? 'subscription' : 'api-key')
  }
  return { success: true }
}

export interface ProbeSubscriptionResult {
  ok: boolean
  message: string
  /** 'format' = passed prefix check only; 'live' = proxy accepted a message. */
  verified: 'format' | 'live'
  error_class?:
    | 'auth.invalid_token'
    | 'provider.unreachable'
    | 'onecli.not_injected'
    | 'unknown'
}

/**
 * Validate a Claude subscription (OAuth) token.
 *
 * The API-key probe (GET /v1/models + x-api-key) REJECTS sk-ant-oat tokens,
 * so we never route a subscription token through probeKey. Instead:
 *   1. Format-gate the `sk-ant-oat` prefix.
 *   2. If the OneCLI proxy + a default agent are up, replicate
 *      scripts/set-auth-mode.sh's probe: a tiny POST /v1/messages THROUGH
 *      the proxy (which injects the *stored* secret) and read the response.
 *
 * Call this AFTER updateOrCreateCredential has stored the token — the probe
 * exercises whatever OneCLI currently holds. When the proxy isn't reachable
 * yet (first-run, before the service is installed) we soft-pass with
 * verified:'format'; the credential is stored and will be exercised on the
 * first real message.
 */
export async function probeSubscriptionToken(
  protocol: string,
  token: string,
  orchestratorRoot?: string | null
): Promise<ProbeSubscriptionResult> {
  const registry = loadProviderRegistry(orchestratorRoot)
  const entry = registry[protocol]
  if (!entry?.subscription_auth) {
    return {
      ok: false,
      message: `${protocol} has no subscription option.`,
      verified: 'format',
      error_class: 'unknown'
    }
  }
  if (!token.startsWith('sk-ant-oat')) {
    return {
      ok: false,
      verified: 'format',
      message: `That doesn't look like a subscription token (${entry.subscription_auth.token_format_hint}). Run \`${entry.subscription_auth.setup_command}\` and paste the value it prints.`,
      error_class: 'auth.invalid_token'
    }
  }

  const bin = findBin('onecli')
  if (!bin) {
    return {
      ok: true,
      verified: 'format',
      message: 'Token saved. OneCLI was not found here — it will be verified on the first message.'
    }
  }

  // Default-agent token for the proxy's basic-auth, and the proxy CA cert.
  const agentsList = await runCommand(bin, ['agents', 'list'])
  let agentToken = ''
  try {
    const agents = JSON.parse(agentsList.stdout) as Array<{
      isDefault?: boolean
      accessToken?: string
    }>
    if (Array.isArray(agents)) {
      agentToken = agents.find((a) => a.isDefault)?.accessToken ?? ''
    }
  } catch {
    /* no agents yet */
  }
  const caLookup = await runCommand('/bin/sh', [
    '-c',
    'ls /var/folders/*/*/T/onecli-proxy-ca.pem 2>/dev/null | head -1'
  ])
  const ca = caLookup.stdout.trim()
  if (!agentToken || !ca) {
    return {
      ok: true,
      verified: 'format',
      message:
        "Token saved. OneCLI's proxy isn't running yet — we'll confirm it on the first message."
    }
  }

  // Do NOT send `x-api-key` here. The stored subscription token injects on
  // `Authorization: Bearer`, and Anthropic evaluates `x-api-key` first — a
  // placeholder x-api-key makes it reject the request with "invalid
  // x-api-key" even though the Bearer token is valid (ben-log 2026-06-09).
  // Omitting it lets OneCLI's Authorization injection stand alone.
  const probe = await runCommand('curl', [
    '-sS',
    '-m',
    '8',
    '-x',
    `http://x:${agentToken}@localhost:10255`,
    '--cacert',
    ca,
    '-H',
    'Content-Type: application/json',
    '-H',
    'anthropic-version: 2023-06-01',
    '-d',
    '{"model":"claude-sonnet-4-6","max_tokens":1,"messages":[{"role":"user","content":"."}]}',
    'https://api.anthropic.com/v1/messages'
  ])
  const body = probe.stdout
  if (body.includes('"id":"msg_') || body.includes('rate_limit_error')) {
    return { ok: true, verified: 'live', message: 'Connected via your Claude subscription.' }
  }
  if (body.includes('authentication_error') || body.includes('invalid x-api-key')) {
    return {
      ok: false,
      verified: 'live',
      message:
        'Anthropic rejected that token. Re-run `claude setup-token` and paste the fresh value.',
      error_class: 'auth.invalid_token'
    }
  }
  if (body.includes('credential_not_found')) {
    return {
      ok: false,
      verified: 'live',
      message: 'OneCLI could not inject the credential. Check `onecli secrets list`.',
      error_class: 'onecli.not_injected'
    }
  }
  // Unknown response — the token format was valid and it is stored; don't
  // hard-fail. It will be exercised on the first real message.
  return {
    ok: true,
    verified: 'format',
    message:
      'Token saved. Could not fully verify through the proxy; it will be exercised on the first message.'
  }
}
