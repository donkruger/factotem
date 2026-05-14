import { app, dialog, ipcMain, shell, BrowserWindow } from 'electron'
import { checkEnv } from './services/env-checker'
import { readState, STATE_PATH, writeState, newState } from './services/state-store'
import { writeProfile } from './services/profile'
import {
  loadDashboardInWindow,
  openDashboardExternal,
  resolveDashboardUrl,
  waitForDashboard
} from './services/dashboard-launcher'
import { dashboardUrl, isFullyHealthy, probeHealth } from './services/health-probe'
import { startRun, cancelRun, runCommand } from './services/subprocess'
import { openInTerminal, platformLabel } from './services/terminal'
import {
  probeOneCLI,
  authenticateOneCLI,
  registerAnthropicSecret
} from './services/onecli'
import {
  installLaunchd,
  isLaunchdLoaded,
  unloadLaunchd
} from './services/service'
import { readMountAllowlist, writeMountAllowlist } from './services/mounts'
import type { MountAllowlist } from '../shared/types'
import {
  startWhatsAppAuth,
  cancelWhatsAppAuth
} from './services/whatsapp'
import {
  listGroups,
  registerGroup,
  type RegisterInput
} from './services/register-group'
import { applyOpenMode, readMainGroup } from './services/openmode'
import type { ProfileWriteInput, SetupState } from '../shared/types'

export function registerIpcHandlers(): void {
  ipcMain.handle('app:version', () => app.getVersion())
  ipcMain.handle('app:quit', () => {
    app.quit()
  })
  ipcMain.handle('app:platform', () => platformLabel())

  ipcMain.handle('env:check', () => checkEnv())

  ipcMain.handle('state:read', () => readState())
  ipcMain.handle('state:path', () => STATE_PATH)
  ipcMain.handle(
    'state:patch',
    async (_e, patch: Partial<SetupState> & { data?: Record<string, unknown> }) => {
      const existing = (await readState()) ?? newState('solo')
      const next: SetupState = {
        ...existing,
        ...patch,
        data: { ...existing.data, ...(patch.data ?? {}) }
      }
      await writeState(next)
      return next
    }
  )

  ipcMain.handle('profile:write', (_e, input: ProfileWriteInput) =>
    writeProfile(input)
  )

  ipcMain.handle('shell:open-external', (_e, url: string) => shell.openExternal(url))

  ipcMain.handle('terminal:run', (_e, command: string) => openInTerminal(command))

  // ── Subprocess streaming ──────────────────────────────────────────────────
  ipcMain.handle(
    'subprocess:start',
    (_e, opts: { cmd: string; args?: string[]; cwd?: string; shell?: boolean }) => {
      const handle = startRun(opts)
      // Resolve when child exits — the renderer also gets `subprocess:exit:<runId>`
      // through the BrowserWindow webContents.send call inside startRun().
      void handle.promise
      return { runId: handle.runId }
    }
  )
  ipcMain.handle('subprocess:cancel', (_e, runId: string) => ({
    cancelled: cancelRun(runId)
  }))
  ipcMain.handle(
    'subprocess:run',
    (_e, opts: { cmd: string; args: string[]; cwd?: string; shell?: boolean }) =>
      runCommand(opts.cmd, opts.args, { cwd: opts.cwd, shell: opts.shell })
  )

  // ── Health + dashboard ────────────────────────────────────────────────────
  ipcMain.handle('health:probe', () => probeHealth())
  ipcMain.handle('health:is-fully-healthy', async () => {
    const h = await probeHealth()
    return { healthy: isFullyHealthy(h), summary: h }
  })
  // What the welcome screen actually wants to know: can the operator
  // skip straight to the dashboard? And if not, why not? Two-state
  // reason so the renderer can show the right helper text.
  ipcMain.handle('dashboard:availability', async () => {
    const summary = await probeHealth(1500)
    if (!summary.reachable) {
      return { available: false, reason: 'orchestrator-down' as const, summary }
    }
    const url = await resolveDashboardUrl()
    if (!url) {
      return { available: false, reason: 'dashboard-missing' as const, summary }
    }
    return { available: true, reason: 'ok' as const, url, summary }
  })
  ipcMain.handle('dashboard:url', () => dashboardUrl())

  // The dashboard (when running inside Electron) uses this to return
  // to the wizard, optionally deep-linked to a specific step.
  ipcMain.handle('wizard:open', async (_e, stepHint?: string) => {
    const { loadWizard } = await import('./index')
    await loadWizard(stepHint)
    return { success: true }
  })
  // dashboard:open is the IN-WINDOW load — the dashboard replaces the
  // wizard's renderer in the same BrowserWindow. Returns {success, url?,
  // error?} so the renderer can show a clean fallback if no dashboard is
  // reachable. dashboard:open-external is kept for the rare case where
  // we genuinely want the system browser.
  ipcMain.handle('dashboard:open', () => loadDashboardInWindow())
  ipcMain.handle('dashboard:open-external', () => openDashboardExternal())
  ipcMain.handle('dashboard:wait', (_e, timeoutMs?: number) => waitForDashboard(timeoutMs))

  // ── OneCLI ────────────────────────────────────────────────────────────────
  ipcMain.handle('onecli:probe', () => probeOneCLI())
  ipcMain.handle('onecli:authenticate', (_e, apiKey: string) =>
    authenticateOneCLI(apiKey)
  )
  ipcMain.handle('onecli:register-anthropic', (_e, secretValue: string) =>
    registerAnthropicSecret(secretValue)
  )

  // ── Service (launchd / systemd) ───────────────────────────────────────────
  ipcMain.handle('service:status', () => isLaunchdLoaded())
  ipcMain.handle('service:install', (_e, orchestratorRoot: string) =>
    installLaunchd(orchestratorRoot)
  )
  ipcMain.handle('service:unload', () => unloadLaunchd())

  // ── Mounts allowlist ──────────────────────────────────────────────────────
  ipcMain.handle('mounts:read', () => readMountAllowlist())
  ipcMain.handle('mounts:write', (_e, allowlist: MountAllowlist) =>
    writeMountAllowlist(allowlist)
  )
  ipcMain.handle('mounts:pick-directory', async () => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    if (!win) return { canceled: true, path: null }
    const result = await dialog.showOpenDialog(win, {
      properties: ['openDirectory', 'createDirectory'],
      title: 'Allow agent container to mount this directory'
    })
    if (result.canceled || result.filePaths.length === 0) {
      return { canceled: true, path: null }
    }
    return { canceled: false, path: result.filePaths[0] }
  })

  // ── WhatsApp pairing (embedded) ───────────────────────────────────────────
  ipcMain.handle('whatsapp:start', (_e, orchestratorRoot: string) =>
    startWhatsAppAuth(orchestratorRoot)
  )
  ipcMain.handle('whatsapp:cancel', (_e, runId: string) => ({
    cancelled: cancelWhatsAppAuth(runId)
  }))

  // ── Main-group registration ───────────────────────────────────────────────
  ipcMain.handle('register:list-groups', (_e, orchestratorRoot: string) =>
    listGroups(orchestratorRoot)
  )
  ipcMain.handle(
    'register:save',
    (_e, orchestratorRoot: string, input: RegisterInput) =>
      registerGroup(orchestratorRoot, input)
  )

  // ── Open-DM mode (SQLite patch + SIGHUP) ──────────────────────────────────
  ipcMain.handle('openmode:read-main', (_e, orchestratorRoot: string) =>
    readMainGroup(orchestratorRoot)
  )
  ipcMain.handle(
    'openmode:apply',
    (_e, orchestratorRoot: string, enabled: boolean, budgetCents: number) =>
      applyOpenMode(orchestratorRoot, enabled, budgetCents)
  )

  // ── Clipboard helper ──────────────────────────────────────────────────────
  ipcMain.handle('clipboard:write', (_e, text: string) => {
    const { clipboard } = require('electron') as typeof import('electron')
    clipboard.writeText(text)
    return { success: true }
  })
}
