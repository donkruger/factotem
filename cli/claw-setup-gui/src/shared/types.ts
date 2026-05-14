// Shared types between main + renderer + preload.
//
// The state schema mirrors `cli/claw-setup/src/state.ts` exactly so that
// both wizards (CLI and GUI) read and write the same setup-state.json
// at ~/.config/nanoclaw/setup-state.json.

export type Profile = 'solo' | 'collaborator-invite' | 'hobbyist'

export interface SetupState {
  version: 1
  profile: Profile
  assistantName: string
  completedSteps: string[]
  currentStep: string | null
  startedAt: string
  lastUpdated: string
  data: Record<string, unknown>
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

export interface ServiceInstallResult {
  success: boolean
  plistPath: string
  bootstrapped: boolean
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
