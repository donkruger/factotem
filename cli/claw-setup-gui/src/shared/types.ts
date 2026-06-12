// Shared types between main + renderer + preload.
//
// The state schema mirrors `cli/claw-setup/src/state.ts` exactly so that
// both wizards (CLI and GUI) read and write the same setup-state.json
// at ~/.config/nanoclaw/setup-state.json.

export type Profile = 'solo' | 'collaborator-invite' | 'hobbyist'

// Mirrors nanoclaw/src/types.ts Provider and Agent. Whenever you change
// one, change all three: this file, nanoclaw/src/types.ts, and
// cli/claw-setup/src/state.ts. See docs/PROVIDER_PLAYBOOK.md § 5.1.

export interface Provider {
  protocol: string
  model: string
  base_url: string | null
  credential_id: string | null
}

export interface Agent {
  id: string
  name: string
  persona: string
  provider: Provider
  memory_namespace: string
  default_trigger: string
  parent_agent_id: string | null
  is_default: boolean
  created_at: string
}

export interface SetupState {
  version: 3
  profile: Profile
  // Legacy single-assistant field — mirrors agents[is_default].name.
  // Preserved on write so v1/v2 readers still work.
  assistantName: string
  completedSteps: string[]
  currentStep: string | null
  startedAt: string
  lastUpdated: string
  data: Record<string, unknown>
  agents: Agent[]
  default_agent_id: string
  // Mirror of agents[is_default].provider. Preserved for v2 readers.
  provider_default?: Provider
}

export interface ProbeResult {
  name: string
  ok: boolean
  detail: string
  installUrl: string
  status: 'ok' | 'warn' | 'error' | 'checking'
}

export interface EnvCheckResult {
  probes: ProbeResult[]
  platform: NodeJS.Platform
  nodeVersion: string
  cwd: string
  orchestratorRoot: string | null
}

export interface ProfileWriteInput {
  profile: Profile
  assistantName: string
  orchestratorRoot: string | null
}

export interface ProfileWriteResult {
  success: boolean
  error?: string
  envOutcome?: 'wrote' | 'exists' | 'created' | 'skipped'
  statePath: string
}

// Mirror of the dashboard's `Health` interface at
// `nanoclaw/dashboard/src/lib/nanoclaw.ts`. Keep byte-compatible —
// the GUI's boot-time `/health` probe reads the same response shape
// the dashboard reads. See nanoclaw/docs/ui-ux-direction.md § State sync.
export interface HealthSummary {
  reachable: boolean // overall: did /health respond?
  nanoclaw: { running: boolean; pid?: number; uptimeSec?: number; version?: string }
  docker: { running: boolean; containers?: number }
  onecli: { reachable: boolean; latencyMs?: number }
  whatsapp: { authenticated: boolean }
  fetchedAt: string // ISO timestamp
  rawError?: string // populated when reachable=false
}

export interface DashboardLocation {
  url: string
  reachable: boolean
}

export interface OneCLIProbe {
  installed: boolean
  version?: string
  gatewayUp: boolean
  authenticated: boolean
  anthropicSecretRegistered: boolean
}

// --- Provider registry (Gemini blueprint PR 2/3) ---------------------------
//
// Mirrors `setup/providers.json` shape. The wizard reads this via
// `window.electronAPI.providers.list()` and renders one card per entry.

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
  /**
   * Optional headers required by the provider's models-endpoint probe
   * but NOT by the OneCLI credential injection. Anthropic, for
   * example, rejects requests missing `anthropic-version`; the runtime
   * SDK sets it automatically inside the agent container but our
   * wizard's curl-based probe has to send it explicitly.
   */
  probe_headers?: Record<string, string>
  /**
   * Present only on providers that can also route through a consumer
   * subscription (Anthropic/Claude). When set, the Credentials step offers
   * an "API key vs subscription" choice; the subscription path collects a
   * long-lived token minted by `setup_command` (`claude setup-token`).
   */
  subscription_auth?: {
    label: string
    tagline: string
    setup_command: string
    token_format_hint: string
    docs_note: string
    /** macOS-only: also offer the keychain auto-rotation watcher. */
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

export type ProviderRegistry = Record<string, ProviderRegistryEntry>

export interface ProbeKeyResult {
  ok: boolean
  message: string
  modelCount?: number
  error_class?:
    | 'auth.invalid_key'
    | 'provider.unreachable'
    | 'quota.rate_limited'
    | 'unknown'
}

export interface CreateCredentialResult {
  success: boolean
  alreadyExisted?: boolean
  error?: string
}

// Result of validating a Claude subscription (OAuth) token. The API-key
// probe can't be reused: GET /v1/models + x-api-key rejects sk-ant-oat
// tokens, so we format-gate the prefix and (when the OneCLI proxy is up)
// round-trip a tiny POST /v1/messages through it. See providers.ts
// probeSubscriptionToken + scripts/set-auth-mode.sh probe_auth.
export interface ProbeSubscriptionResult {
  ok: boolean
  message: string
  /** 'format' = passed prefix check only (proxy not reachable yet);
   *  'live' = the OneCLI proxy round-tripped a real message to Anthropic. */
  verified: 'format' | 'live'
  error_class?:
    | 'auth.invalid_token'
    | 'provider.unreachable'
    | 'onecli.not_injected'
    | 'unknown'
}

// Result of driving scripts/set-auth-mode.sh (macOS keychain auto-rotation).
export interface SetAuthModeResult {
  success: boolean
  output?: string
  error?: string
}

export interface ClaudeDetectResult {
  installed: boolean
  /** Absolute path to the resolved `claude` binary, or null when not found. */
  path: string | null
}

export interface ServiceInstallResult {
  success: boolean
  plistPath: string
  bootstrapped: boolean
  error?: string
}

// Result of a one-click "start the orchestrator" attempt. `reason`
// lets the UI tailor its copy: `not-installed` → finish setup first,
// `unsupported` → non-macOS manual start, `error` → launchctl failed.
export interface ServiceStartResult {
  success: boolean
  reason: 'started' | 'not-installed' | 'unsupported' | 'error'
  error?: string
}

// Mirrors `MountAllowlist` + `AllowedRoot` in `nanoclaw/src/types.ts`.
// Don't simplify — the orchestrator's mount-security layer reads these
// fields per-entry. If the GUI writes a bare string[] the file
// validates wrong and the agent container loses all mount access.
export interface AllowedRoot {
  path: string
  allowReadWrite: boolean
  description?: string
}

export interface MountAllowlist {
  allowedRoots: AllowedRoot[]
  blockedPatterns: string[]
  nonMainReadOnly: boolean
}
