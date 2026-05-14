import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI as toolkitAPI } from '@electron-toolkit/preload'
import type {
  EnvCheckResult,
  HealthSummary,
  MountAllowlist,
  OneCLIProbe,
  ProfileWriteInput,
  ProfileWriteResult,
  ServiceInstallResult,
  SetupState
} from '../shared/types'

// IPC surface exposed to the renderer. See cli/claw-setup-gui/CLAUDE.md
// § IPC channel discipline — adding a channel touches three files in
// the same commit (this file, ipc-handlers.ts, preload/index.d.ts).
const electronAPI = {
  app: {
    version: (): Promise<string> => ipcRenderer.invoke('app:version'),
    quit: (): Promise<void> => ipcRenderer.invoke('app:quit'),
    platform: (): Promise<string> => ipcRenderer.invoke('app:platform')
  },
  env: {
    check: (): Promise<EnvCheckResult> => ipcRenderer.invoke('env:check')
  },
  state: {
    read: (): Promise<SetupState | null> => ipcRenderer.invoke('state:read'),
    statePath: (): Promise<string> => ipcRenderer.invoke('state:path'),
    patch: (
      patch: Partial<SetupState> & { data?: Record<string, unknown> }
    ): Promise<SetupState> => ipcRenderer.invoke('state:patch', patch)
  },
  profile: {
    write: (input: ProfileWriteInput): Promise<ProfileWriteResult> =>
      ipcRenderer.invoke('profile:write', input)
  },
  shell: {
    openExternal: (url: string): Promise<void> =>
      ipcRenderer.invoke('shell:open-external', url)
  },
  wizard: {
    // Reload the wizard into this window, optionally deep-linked to a
    // step. Used by the dashboard's "Setup" link and subsystem-card
    // click-throughs.
    open: (stepHint?: string): Promise<{ success: boolean }> =>
      ipcRenderer.invoke('wizard:open', stepHint)
  },
  terminal: {
    run: (command: string): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke('terminal:run', command)
  },
  clipboard: {
    write: (text: string): Promise<{ success: boolean }> =>
      ipcRenderer.invoke('clipboard:write', text)
  },
  subprocess: {
    start: (opts: {
      cmd: string
      args?: string[]
      cwd?: string
      shell?: boolean
    }): Promise<{ runId: string }> => ipcRenderer.invoke('subprocess:start', opts),
    cancel: (runId: string): Promise<{ cancelled: boolean }> =>
      ipcRenderer.invoke('subprocess:cancel', runId),
    run: (opts: {
      cmd: string
      args: string[]
      cwd?: string
      shell?: boolean
    }): Promise<{ stdout: string; stderr: string; code: number }> =>
      ipcRenderer.invoke('subprocess:run', opts),
    onLine: (runId: string, cb: (line: string) => void): (() => void) => {
      const channel = `subprocess:line:${runId}`
      const listener = (_e: unknown, line: string): void => cb(line)
      ipcRenderer.on(channel, listener)
      return () => ipcRenderer.off(channel, listener)
    },
    onExit: (runId: string, cb: (info: { code: number }) => void): (() => void) => {
      const channel = `subprocess:exit:${runId}`
      const listener = (_e: unknown, info: { code: number }): void => cb(info)
      ipcRenderer.on(channel, listener)
      return () => ipcRenderer.off(channel, listener)
    }
  },
  health: {
    probe: (): Promise<HealthSummary> => ipcRenderer.invoke('health:probe'),
    isFullyHealthy: (): Promise<{ healthy: boolean; summary: HealthSummary }> =>
      ipcRenderer.invoke('health:is-fully-healthy')
  },
  dashboard: {
    url: (): Promise<string> => ipcRenderer.invoke('dashboard:url'),
    // In-window load: replaces the wizard's renderer with the dashboard
    // in the same BrowserWindow. Returns the resolved URL on success.
    open: (): Promise<{ success: boolean; url?: string; error?: string }> =>
      ipcRenderer.invoke('dashboard:open'),
    openExternal: (): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke('dashboard:open-external'),
    waitForReady: (timeoutMs?: number): Promise<boolean> =>
      ipcRenderer.invoke('dashboard:wait', timeoutMs),
    availability: (): Promise<
      | { available: true; reason: 'ok'; url: string; summary: HealthSummary }
      | {
          available: false
          reason: 'orchestrator-down' | 'dashboard-missing'
          summary: HealthSummary
        }
    > => ipcRenderer.invoke('dashboard:availability')
  },
  onecli: {
    probe: (): Promise<OneCLIProbe> => ipcRenderer.invoke('onecli:probe'),
    authenticate: (apiKey: string): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke('onecli:authenticate', apiKey),
    registerAnthropic: (
      secretValue: string
    ): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke('onecli:register-anthropic', secretValue)
  },
  service: {
    status: (): Promise<boolean> => ipcRenderer.invoke('service:status'),
    install: (orchestratorRoot: string): Promise<ServiceInstallResult> =>
      ipcRenderer.invoke('service:install', orchestratorRoot),
    unload: (): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke('service:unload')
  },
  mounts: {
    read: (): Promise<MountAllowlist> => ipcRenderer.invoke('mounts:read'),
    write: (allowlist: MountAllowlist): Promise<void> =>
      ipcRenderer.invoke('mounts:write', allowlist),
    pickDirectory: (): Promise<{ canceled: boolean; path: string | null }> =>
      ipcRenderer.invoke('mounts:pick-directory')
  },
  openmode: {
    readMain: (
      orchestratorRoot: string
    ): Promise<
      | { found: true; group: { jid: string; name: string; exists: true } }
      | { found: false; reason: string }
    > => ipcRenderer.invoke('openmode:read-main', orchestratorRoot),
    apply: (
      orchestratorRoot: string,
      enabled: boolean,
      budgetCents: number
    ): Promise<{
      success: boolean
      appliedToJid?: string
      appliedToName?: string
      sighup: boolean
      error?: string
    }> => ipcRenderer.invoke('openmode:apply', orchestratorRoot, enabled, budgetCents)
  },
  register: {
    listGroups: (
      orchestratorRoot: string
    ): Promise<{ groups: Array<{ jid: string; name: string }>; error?: string }> =>
      ipcRenderer.invoke('register:list-groups', orchestratorRoot),
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
    ): Promise<{ success: boolean; sighup: boolean; error?: string }> =>
      ipcRenderer.invoke('register:save', orchestratorRoot, input)
  },
  whatsapp: {
    start: (
      orchestratorRoot: string
    ): Promise<{
      runId: string
      qrPath: string
      statusPath: string
      credsPath: string
    }> => ipcRenderer.invoke('whatsapp:start', orchestratorRoot),
    cancel: (runId: string): Promise<{ cancelled: boolean }> =>
      ipcRenderer.invoke('whatsapp:cancel', runId),
    onQr: (runId: string, cb: (qr: string) => void): (() => void) => {
      const channel = `whatsapp:qr:${runId}`
      const listener = (_e: unknown, qr: string): void => cb(qr)
      ipcRenderer.on(channel, listener)
      return () => ipcRenderer.off(channel, listener)
    },
    onStatus: (runId: string, cb: (status: string) => void): (() => void) => {
      const channel = `whatsapp:status:${runId}`
      const listener = (_e: unknown, status: string): void => cb(status)
      ipcRenderer.on(channel, listener)
      return () => ipcRenderer.off(channel, listener)
    },
    onLine: (runId: string, cb: (line: string) => void): (() => void) => {
      const channel = `whatsapp:line:${runId}`
      const listener = (_e: unknown, line: string): void => cb(line)
      ipcRenderer.on(channel, listener)
      return () => ipcRenderer.off(channel, listener)
    },
    onExit: (runId: string, cb: (info: { code: number }) => void): (() => void) => {
      const channel = `whatsapp:exit:${runId}`
      const listener = (_e: unknown, info: { code: number }): void => cb(info)
      ipcRenderer.on(channel, listener)
      return () => ipcRenderer.off(channel, listener)
    }
  }
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', toolkitAPI)
    contextBridge.exposeInMainWorld('electronAPI', electronAPI)
  } catch (err) {
    console.error('contextBridge expose failed:', err)
  }
} else {
  // @ts-expect-error legacy
  window.electron = toolkitAPI
  // @ts-expect-error legacy
  window.electronAPI = electronAPI
}

export type ElectronAPI = typeof electronAPI
