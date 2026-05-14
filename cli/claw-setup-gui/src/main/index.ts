import { app, BrowserWindow, Menu, session, shell } from 'electron'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { join } from 'path'
import { registerIpcHandlers } from './ipc-handlers'
import { probeHealth } from './services/health-probe'
import { loadDashboardInWindow, resolveDashboardUrl } from './services/dashboard-launcher'

let mainWindow: BrowserWindow | null = null

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 880,
    minHeight: 640,
    show: false,
    backgroundColor: '#fafafa',
    autoHideMenuBar: process.platform !== 'darwin',
    // Standard native title bar everywhere. The previous `hiddenInset`
    // on macOS gave the wizard a chrome-less look but reserved an
    // invisible 28px drag region at the top of the window — when we
    // navigate to the dashboard (different document, no -webkit-app-
    // region CSS) the dashboard's top nav rendered into that drag
    // region and clicks got eaten by the OS instead of reaching React.
    // A normal title bar above the content area sidesteps the whole
    // issue and lets both surfaces use 0..top edge to edge.
    titleBarStyle: 'default',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true
    }
  })

  win.on('ready-to-show', () => win.show())

  // External link clicks inside the dashboard (Anthropic console etc.)
  // go to the user's real browser — keep them out of our window.
  win.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  win.on('closed', () => {
    mainWindow = null
  })

  return win
}

// Load the wizard's renderer into the main window. An optional step
// hint becomes a URL hash (#whatsapp etc.) that App.tsx reads on mount
// to jump to that step — used by the dashboard's "Setup" affordances
// to deep-link back into a specific part of the journey.
async function loadWizard(stepHint?: string): Promise<void> {
  if (!mainWindow) mainWindow = createWindow()
  const hash = stepHint ? `#${stepHint}` : ''
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    await mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'] + hash)
  } else {
    await mainWindow.loadFile(join(__dirname, '../renderer/index.html'), {
      hash: stepHint
    })
  }
}

// Load the Factotem dashboard into the main window. Returns true if
// a dashboard was found and loaded; false if neither :7842 nor :3001
// serves it.
async function loadDashboard(): Promise<boolean> {
  if (!mainWindow) mainWindow = createWindow()
  const r = await loadDashboardInWindow()
  if (!r.success) {
    // Couldn't reach a dashboard — fall back to the wizard so the user
    // isn't staring at a chromeless error page.
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
// button clicks.
export { loadDashboard, loadWizard }
