// Orchestrator health probe + dashboard URL helpers.
//
// Two ports, two purposes:
//
//   Orchestrator HTTP API   → :7842  (NANOCLAW_HTTP_PORT in src/config.ts)
//   Dashboard Next.js page  → :3001  (next dev -p 3001)
//
// `/health` is served by the orchestrator (7842). The dashboard fetches
// from the orchestrator via NEXT_PUBLIC_NANOCLAW_URL or relative paths;
// it doesn't proxy /health itself. So:
//
//   probeHealth()       → http://127.0.0.1:7842/health   (what we probe)
//   dashboardUrl()      → http://127.0.0.1:3001          (what we open)
//
// Both ports are overridable via env vars for dev / non-default
// configurations. See nanoclaw/docs/ui-ux-direction.md § Hand-off rules.

import type { HealthSummary } from '../../shared/types'

const DEFAULT_ORCHESTRATOR_URL = 'http://127.0.0.1:7842'
const DEFAULT_DASHBOARD_URL = 'http://127.0.0.1:3001'

export function orchestratorUrl(): string {
  return (
    process.env['NANOCLAW_HTTP_URL'] ||
    (process.env['NANOCLAW_HTTP_PORT']
      ? `http://127.0.0.1:${process.env['NANOCLAW_HTTP_PORT']}`
      : DEFAULT_ORCHESTRATOR_URL)
  )
}

export function dashboardUrl(): string {
  return process.env['NANOCLAW_DASHBOARD_URL'] || DEFAULT_DASHBOARD_URL
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    return await fetch(url, { signal: ctrl.signal })
  } finally {
    clearTimeout(timer)
  }
}

export async function probeHealth(timeoutMs = 2000): Promise<HealthSummary> {
  const fetchedAt = new Date().toISOString()
  const url = `${orchestratorUrl()}/health`

  try {
    const res = await fetchWithTimeout(url, timeoutMs)
    if (!res.ok) {
      return emptySummary({ fetchedAt, rawError: `HTTP ${res.status}` })
    }
    // The orchestrator's response (nanoclaw/src/http/health.ts) uses
    // snake_case fields. We expose camelCase to the renderer so the
    // existing component code stays idiomatic — translate here.
    type RawHealth = {
      nanoclaw?: { running?: boolean; pid?: number; uptime_seconds?: number; version?: string }
      docker?: { running?: boolean; containers_active?: number }
      onecli?: { reachable?: boolean; latency_ms?: number | null }
      whatsapp?: { authenticated?: boolean }
    }
    const body = (await res.json()) as RawHealth
    return {
      reachable: true,
      nanoclaw: {
        // /health only responds when the orchestrator is up, so `running`
        // is effectively true by virtue of the response existing. The
        // `running` field in the body is literally typed `true` upstream.
        running: body.nanoclaw?.running ?? true,
        pid: body.nanoclaw?.pid,
        uptimeSec: body.nanoclaw?.uptime_seconds,
        version: body.nanoclaw?.version
      },
      docker: {
        running: !!body.docker?.running,
        containers: body.docker?.containers_active
      },
      onecli: {
        reachable: !!body.onecli?.reachable,
        latencyMs: body.onecli?.latency_ms ?? undefined
      },
      whatsapp: {
        authenticated: !!body.whatsapp?.authenticated
      },
      fetchedAt
    }
  } catch (err) {
    return emptySummary({
      fetchedAt,
      rawError: (err as Error).message || 'unknown error'
    })
  }
}

// "Did /health respond at all?" is just `h.reachable` — callers can
// inline that. We used to export an isOrchestratorAlive() wrapper but
// nobody imported it; removed to keep the surface area small.

export function isFullyHealthy(h: HealthSummary): boolean {
  return (
    h.reachable &&
    h.nanoclaw.running &&
    h.docker.running &&
    h.onecli.reachable &&
    h.whatsapp.authenticated
  )
}

function emptySummary(over: { fetchedAt: string; rawError: string }): HealthSummary {
  return {
    reachable: false,
    nanoclaw: { running: false },
    docker: { running: false },
    onecli: { reachable: false },
    whatsapp: { authenticated: false },
    ...over
  }
}
