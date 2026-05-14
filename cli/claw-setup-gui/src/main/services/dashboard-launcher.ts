// Dashboard launcher — in-window navigation.
//
// The Factotem dashboard can be served from one of two places:
//
//   • PRODUCTION:  the orchestrator's Express app at :7842 serves the
//                  static export from `nanoclaw/dashboard/out/` (built
//                  via `cd dashboard && npm run build`).
//   • DEV:         `next dev -p 3001` inside the dashboard package.
//
// We probe both, picking the first that returns HTML. The Electron
// shell then `loadURL`s that into its existing BrowserWindow — the
// dashboard runs *inside* the app instead of bouncing to the user's
// default browser (which was the v0.1 behaviour and broke when the
// dashboard wasn't separately running).

import { shell, BrowserWindow } from 'electron'
import { dashboardUrl, orchestratorUrl, probeHealth } from './health-probe'

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    return await fetch(url, { signal: ctrl.signal })
  } finally {
    clearTimeout(t)
  }
}

// True when `<url>/` returns 200 + text/html — i.e. someone is actually
// serving the dashboard pages there. `/health` always responds at 7842
// (the orchestrator's API), but the root path only returns HTML when
// the static dashboard has been built and mounted.
async function servesDashboard(url: string): Promise<boolean> {
  try {
    const res = await fetchWithTimeout(`${url}/`, 1500)
    if (!res.ok) return false
    const ct = res.headers.get('content-type') ?? ''
    return ct.includes('text/html')
  } catch {
    return false
  }
}

export async function resolveDashboardUrl(): Promise<string | null> {
  // Orchestrator first (production setup), then next-dev fallback.
  for (const candidate of [orchestratorUrl(), dashboardUrl()]) {
    if (await servesDashboard(candidate)) return candidate
  }
  return null
}

// In-window navigation. Loads the resolved dashboard URL into the
// currently-focused (or first) BrowserWindow. Returns false if no
// dashboard is reachable so the caller can surface a helpful message
// instead of a blank "site can't be reached" page.
export async function loadDashboardInWindow(): Promise<{
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
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  if (!win) {
    return { success: false, error: 'No window to load into.' }
  }

  // Clear the session HTTP cache and force-reload-from-origin headers
  // before navigating. Without this, Electron happily serves the
  // previously-cached dashboard bundle even after `npm run build` in
  // dashboard/ produces fresh JS — operators see stale UI and assume
  // their build didn't take. ETag caching of Next.js chunks is the
  // usual culprit here.
  try {
    await win.webContents.session.clearCache()
  } catch {
    /* clearCache failures are non-fatal; we just won't get fresh bytes */
  }
  await win.loadURL(url, { extraHeaders: 'pragma: no-cache\ncache-control: no-cache' })
  return { success: true, url }
}

// Legacy alias — still used by edge cases that genuinely need the
// system browser (e.g. open OneCLI dashboard which is also at 127.0.0.1
// but isn't the Factotem dashboard).
export async function openDashboardExternal(): Promise<{
  success: boolean
  error?: string
}> {
  try {
    const url = (await resolveDashboardUrl()) ?? dashboardUrl()
    await shell.openExternal(url)
    return { success: true }
  } catch (err) {
    return { success: false, error: (err as Error).message }
  }
}

// Wait for /health to respond — used by the end-of-wizard ReadyStep
// to confirm the orchestrator is up before navigating to the dashboard.
export async function waitForDashboard(timeoutMs = 30000): Promise<boolean> {
  const startedAt = Date.now()
  const pollIntervalMs = 500
  while (Date.now() - startedAt < timeoutMs) {
    const h = await probeHealth(1000)
    if (h.reachable) return true
    await new Promise((r) => setTimeout(r, pollIntervalMs))
  }
  return false
}
