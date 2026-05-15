import type { ElectronAPI as ToolkitElectronAPI } from '@electron-toolkit/preload'
import type {
  CreateCredentialResult,
  EnvCheckResult,
  HealthSummary,
  MountAllowlist,
  OneCLIProbe,
  ProbeKeyResult,
  ProfileWriteInput,
  ProfileWriteResult,
  ProviderRegistry,
  ServiceInstallResult,
  SetupState
} from '../shared/types'

interface ElectronAPI {
  app: {
    version: () => Promise<string>
    quit: () => Promise<void>
    platform: () => Promise<string>
  }
  env: {
    check: () => Promise<EnvCheckResult>
  }
  state: {
    read: () => Promise<SetupState | null>
    statePath: () => Promise<string>
    patch: (
      patch: Partial<SetupState> & { data?: Record<string, unknown> }
    ) => Promise<SetupState>
  }
  profile: {
    write: (input: ProfileWriteInput) => Promise<ProfileWriteResult>
  }
  shell: {
    openExternal: (url: string) => Promise<void>
  }
  wizard: {
    open: (stepHint?: string) => Promise<{ success: boolean }>
  }
  terminal: {
    run: (command: string) => Promise<{ success: boolean; error?: string }>
  }
  clipboard: {
    write: (text: string) => Promise<{ success: boolean }>
  }
  subprocess: {
    start: (opts: {
      cmd: string
      args?: string[]
      cwd?: string
      shell?: boolean
    }) => Promise<{ runId: string }>
    cancel: (runId: string) => Promise<{ cancelled: boolean }>
    run: (opts: {
      cmd: string
      args: string[]
      cwd?: string
      shell?: boolean
    }) => Promise<{ stdout: string; stderr: string; code: number }>
    onLine: (runId: string, cb: (line: string) => void) => () => void
    onExit: (runId: string, cb: (info: { code: number }) => void) => () => void
  }
  health: {
    probe: () => Promise<HealthSummary>
    isFullyHealthy: () => Promise<{ healthy: boolean; summary: HealthSummary }>
  }
  dashboard: {
    url: () => Promise<string>
    open: () => Promise<{ success: boolean; url?: string; error?: string }>
    openExternal: () => Promise<{ success: boolean; error?: string }>
    waitForReady: (timeoutMs?: number) => Promise<boolean>
    availability: () => Promise<
      | { available: true; reason: 'ok'; url: string; summary: HealthSummary }
      | {
          available: false
          reason: 'orchestrator-down' | 'dashboard-missing'
          summary: HealthSummary
        }
    >
  }
  onecli: {
    probe: () => Promise<OneCLIProbe>
    authenticate: (apiKey: string) => Promise<{ success: boolean; error?: string }>
    registerAnthropic: (
      secretValue: string
    ) => Promise<{ success: boolean; error?: string }>
  }
  providers: {
    list: (orchestratorRoot?: string | null) => Promise<ProviderRegistry>
    probeKey: (
      protocol: string,
      apiKey: string,
      orchestratorRoot?: string | null
    ) => Promise<ProbeKeyResult>
    createCredential: (
      protocol: string,
      apiKey: string,
      orchestratorRoot?: string | null
    ) => Promise<CreateCredentialResult>
  }
  service: {
    status: () => Promise<boolean>
    install: (orchestratorRoot: string) => Promise<ServiceInstallResult>
    unload: () => Promise<{ success: boolean; error?: string }>
  }
  mounts: {
    read: () => Promise<MountAllowlist>
    write: (allowlist: MountAllowlist) => Promise<void>
    pickDirectory: () => Promise<{ canceled: boolean; path: string | null }>
  }
  openmode: {
    readMain: (
      orchestratorRoot: string
    ) => Promise<
      | { found: true; group: { jid: string; name: string; exists: true } }
      | { found: false; reason: string }
    >
    apply: (
      orchestratorRoot: string,
      enabled: boolean,
      budgetCents: number
    ) => Promise<{
      success: boolean
      appliedToJid?: string
      appliedToName?: string
      sighup: boolean
      error?: string
    }>
  }
  pairings: {
    list: () => Promise<{
      pairings: Array<{
        id: string
        kind: string
        display_name: string
        auth_path: string
        is_shared: boolean
        phone_hint: string | null
        last_connected_at: string | null
        created_at: string
      }>
      error?: string
    }>
    create: (input: {
      id?: string
      kind: string
      display_name: string
      auth_path?: string
      is_shared?: boolean
      phone_hint?: string | null
    }) => Promise<{
      success: boolean
      pairing?: {
        id: string
        kind: string
        display_name: string
        auth_path: string
        is_shared: boolean
        phone_hint: string | null
        last_connected_at: string | null
        created_at: string
      }
      error?: string
    }>
    assignAgent: (
      agentId: string,
      pairingId: string
    ) => Promise<{ success: boolean; error?: string }>
  }
  register: {
    listGroups: (
      orchestratorRoot: string
    ) => Promise<{ groups: Array<{ jid: string; name: string }>; error?: string }>
    save: (
      orchestratorRoot: string,
      input: {
        jid: string
        name: string
        trigger: string
        folder: string
        isMain: boolean
        assistantName: string
      }
    ) => Promise<{ success: boolean; sighup: boolean; error?: string }>
  }
  whatsapp: {
    start: (
      orchestratorRoot: string,
      opts?: { pairingId?: string; authDir?: string }
    ) => Promise<{
      runId: string
      qrPath: string
      statusPath: string
      credsPath: string
    }>
    cancel: (runId: string) => Promise<{ cancelled: boolean }>
    onQr: (runId: string, cb: (qr: string) => void) => () => void
    onStatus: (runId: string, cb: (status: string) => void) => () => void
    onLine: (runId: string, cb: (line: string) => void) => () => void
    onExit: (runId: string, cb: (info: { code: number }) => void) => () => void
  }
}

declare global {
  interface Window {
    electron: ToolkitElectronAPI
    electronAPI: ElectronAPI
  }
}

export {}
