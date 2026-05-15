import { app, BrowserWindow, Menu, session, shell } from 'electron'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { join } from 'path'
import { registerIpcHandlers } from './ipc-handlers'
import { probeHealth } from './services/health-probe'
import { loadDashboardInWindow, resolveDashboardUrl } from './services/dashboard-launcher'

let mainWindow: BrowserWindow | null = null
type Mode = 'wizard' | 'dashboard'
let currentMode: Mode | null = null

const COMMON_WINDOW_OPTS = {
  minWidth: 880,
  minHeight: 640,
  show: false
} as const

function webPrefs(): Electron.WebPreferences {
  return {
    preload: join(__dirname, '../preload/index.js'),
    sandbox: false,
    contextIsolation: true
  }
}

// Wizard window — chrome-less. The cream panel extends all the way to
// the window edge: on macOS `hiddenInset` removes the title bar and
// keeps the traffic lights at their standard inset position; on Windows
// `hidden` + `titleBarOverlay` paints the system min/max/close buttons
// directly onto our content with matching colours. The renderer
// reserves a safe zone for those controls and provides a draggable
// strip at the top of the app so the window can still be moved (see
// `App.tsx` <TitleBar /> and `main.css` .title-bar rules).
//
// The dashboard surface uses `createDashboardWindow` below, which keeps
// the OS-native title bar. Switching surfaces recreates the window
// (see `loadWizard` / `loadDashboard`) so the title-bar style — which
// is constructor-only in Electron — always matches the document being
// rendered. This sidesteps the historical regression where the
// dashboard's top nav fell inside the macOS drag region when both
// surfaces shared a single `hiddenInset` window and clicks got eaten
// by the OS instead of reaching React.
function createWizardWindow(bounds?: Electron.Rectangle): BrowserWindow {
  const isMac = process.platform === 'darwin'
  const isWin = process.platform === 'win32'

  const win = new BrowserWindow({
    ...COMMON_WINDOW_OPTS,
    width: bounds?.width ?? 1100,
    height: bounds?.height ?? 760,
    ...(bounds?.x !== undefined ? { x: bounds.x, y: bounds.y } : {}),
    backgroundColor: '#fafafa',
    autoHideMenuBar: !isMac,
    ...(isMac && { titleBarStyle: 'hiddenInset' as const }),
    ...(isWin && {
      titleBarStyle: 'hidden' as const,
      titleBarOverlay: {
        // Match the wizard body background (#fafafa) and ink colour so
        // the Windows min/max/close glyphs blend into the cream panel.
        color: '#fafafa',
        symbolColor: '#1d1d1f',
        height: 36
      }
    }),
    webPreferences: webPrefs()
  })

  wireWindow(win)
  return win
}

// Dashboard window — OS-native title bar. The Factotem dashboard is a
// Next.js app designed for the browser and isn't aware of macOS drag
// regions; keeping the system chrome here means its top nav stays
// clickable end-to-end. Background nudged to white because the
// dashboard itself isn't on the cream wizard palette.
function createDashboardWindow(bounds?: Electron.Rectangle): BrowserWindow {
  const win = new BrowserWindow({
    ...COMMON_WINDOW_OPTS,
    width: bounds?.width ?? 1100,
    height: bounds?.height ?? 760,
    ...(bounds?.x !== undefined ? { x: bounds.x, y: bounds.y } : {}),
    backgroundColor: '#ffffff',
    autoHideMenuBar: process.platform !== 'darwin',
    titleBarStyle: 'default',
    webPreferences: webPrefs()
  })

  wireWindow(win)
  return win
}

// Per-window wiring shared by both factories: external links go to the
// user's real browser, and we clear `mainWindow` on close.
function wireWindow(win: BrowserWindow): void {
  win.on('ready-to-show', () => win.show())

  win.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  win.on('closed', () => {
    if (mainWindow === win) {
      mainWindow = null
      currentMode = null
    }
  })
}

// Swap to a window matching `mode` if the current one is the wrong
// kind. We wait for `ready-to-show` on the new window before destroying
// the old one so the user sees a continuous frame rather than a flash
// of empty desktop between window destruction and re-creation. Bounds
// are preserved so the new window appears in the same place.
async function ensureWindowFor(mode: Mode): Promise<BrowserWindow> {
  if (mainWindow && currentMode === mode) return mainWindow

  const bounds = mainWindow?.getBounds()
  const next = mode === 'wizard' ? createWizardWindow(bounds) : createDashboardWindow(bounds)

  if (mainWindow) {
    const old = mainWindow
    await new Promise<void>((resolve) => {
      next.once('ready-to-show', () => resolve())
    })
    old.destroy()
  }

  mainWindow = next
  currentMode = mode
  return next
}

// Load the wizard's renderer into the wizard window. An optional step
// hint becomes a URL hash (#whatsapp etc.) that App.tsx reads on mount
// to jump to that step — used by the dashboard's "Setup" affordances
// to deep-link back into a specific part of the journey.
//
// `ensureWindowFor('wizard')` recreates the window with the wizard's
// chrome-less title-bar style if we were previously on the dashboard.
async function loadWizard(stepHint?: string): Promise<void> {
  const win = await ensureWindowFor('wizard')
  const hash = stepHint ? `#${stepHint}` : ''
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    await win.loadURL(process.env['ELECTRON_RENDERER_URL'] + hash)
  } else {
    await win.loadFile(join(__dirname, '../renderer/index.html'), {
      hash: stepHint
    })
  }
}

// Probe the dashboard URL, swap to the dashboard window if reachable,
// and load it. Returns the rich result object so the renderer's
// `dashboard:open` IPC handler can surface a clean error inline rather
// than navigating to a broken page. Crucially, the window swap is
// guarded by URL availability — if no dashboard is reachable we leave
// the wizard window untouched, which is what the welcome-step button
// callers want.
//
// `targetWin` from `ensureWindowFor` is passed explicitly to
// `loadDashboardInWindow` to avoid a race: right after the swap,
// `BrowserWindow.getFocusedWindow()` can still return the old (now
// destroyed) window because focus is asynchronous on macOS.
async function openDashboard(): Promise<{
  success: boolean
  url?: string
  error?: string
}> {
  const url = await resolveDashboardUrl()
  if (!url) {
    return {
      success: false,
      error:
        "Dashboard isn't being served on http://127.0.0.1:7842 or :3001. " +
        'Build it with `cd nanoclaw/dashboard && npm run build` (then restart the orchestrator), ' +
        'or run `npm run dev` inside the dashboard package for hot-reload.'
    }
  }
  const win = await ensureWindowFor('dashboard')
  return loadDashboardInWindow(win)
}

// Load the Factotem dashboard into the dashboard window. Returns true
// if a dashboard was found and loaded; false if neither :7842 nor :3001
// serves it (in which case we fall back to the wizard so the user
// isn't staring at a blank window). This is the menu / boot-time
// entry point; the IPC handler uses `openDashboard` directly so the
// renderer can surface inline errors without a wizard flash.
async function loadDashboard(): Promise<boolean> {
  const r = await openDashboard()
  if (!r.success) {
    await loadWizard()
    return false
  }
  return true
}

function buildAppMenu(): void {
  const isMac = process.platform === 'darwin'
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' as const },
              { type: 'separator' as const },
              { role: 'services' as const },
              { type: 'separator' as const },
              { role: 'hide' as const },
              { role: 'hideOthers' as const },
              { role: 'unhide' as const },
              { type: 'separator' as const },
              { role: 'quit' as const }
            ]
          }
        ]
      : []),
    {
      label: 'View',
      submenu: [
        {
          label: 'Dashboard',
          accelerator: 'CmdOrCtrl+Shift+D',
          click: () => {
            void loadDashboard()
          }
        },
        {
          label: 'Setup Wizard',
          accelerator: 'CmdOrCtrl+Shift+W',
          click: () => {
            void loadWizard()
          }
        },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

// Boot decision: take the user to the dashboard if (a) the orchestrator
// is alive and (b) a dashboard exists to open. We deliberately don't
// require every subsystem (docker, onecli, whatsapp) to be green —
// transient unhealth there is exactly the kind of thing the dashboard
// surfaces, and dumping the operator back into setup whenever WhatsApp
// reconnects or docker hiccups would be hostile UX.
//
// NANOCLAW_FORCE_WIZARD=1 always shows the wizard, for iteration.
async function decideBoot(): Promise<'dashboard' | 'wizard'> {
  if (process.env['NANOCLAW_FORCE_WIZARD']) return 'wizard'

  const health = await probeHealth(1500)
  if (!health.reachable) return 'wizard'

  const dashUrl = await resolveDashboardUrl()
  return dashUrl ? 'dashboard' : 'wizard'
}

app.whenReady().then(async () => {
  electronApp.setAppUserModelId('com.nanoclaw.claw-setup-gui')

  app.on('browser-window-created', (_, w) => optimizer.watchWindowShortcuts(w))

  // Silence Electron's "Insecure Content-Security-Policy" warning by
  // setting an explicit (permissive) CSP on file:// loads. The dashboard
  // at http://127.0.0.1:7842 serves its own CSP and we don't touch it.
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const isLocalRenderer =
      details.url.startsWith('file://') ||
      details.url.startsWith('http://localhost:') ||
      details.url.startsWith('http://127.0.0.1:5173')
    if (!isLocalRenderer) {
      callback({ responseHeaders: details.responseHeaders })
      return
    }
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self' 'unsafe-inline' http://127.0.0.1:* http://localhost:* https://fonts.googleapis.com https://fonts.gstatic.com data:;" +
            "script-src 'self' 'unsafe-inline' http://localhost:* http://127.0.0.1:*;" +
            "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com;" +
            "font-src 'self' https://fonts.gstatic.com data:;" +
            "img-src 'self' data: blob:;" +
            "connect-src 'self' http://127.0.0.1:* http://localhost:*;"
        ]
      }
    })
  })

  registerIpcHandlers()
  buildAppMenu()

  const where = await decideBoot()
  if (where === 'dashboard') {
    await loadDashboard()
  } else {
    await loadWizard()
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void loadWizard()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// Re-exported so ipc-handlers can call them too. The handlers in
// ipc-handlers.ts use these to navigate the window from renderer-side
// button clicks. `openDashboard` is the IPC-facing variant that
// returns the rich {success, url?, error?} object and does NOT fall
// back to the wizard on failure.
export { loadDashboard, loadWizard, openDashboard }
