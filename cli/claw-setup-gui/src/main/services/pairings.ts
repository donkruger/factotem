// Channel pairings — HTTP-thin wrapper.
//
// PairingChoiceStep (v1.2.1-finish-blueprint § 2) needs to read the
// existing pairings and create a new one when the operator opts for a
// per-agent WhatsApp number. The orchestrator's HTTP API already does
// both — see `src/http/api.ts` GET /api/pairings + POST /api/pairings —
// so this service is just a typed fetch wrapper.
//
// Why HTTP rather than reading SQLite directly: creating a pairing has
// a side-effect (`deps.reloadConfig()` so the channel-factory picks up
// the new auth dir without an orchestrator restart). Hitting the
// existing endpoint preserves that behaviour for free.

import { orchestratorUrl } from './health-probe'

export interface ChannelPairing {
  id: string
  kind: string
  display_name: string
  auth_path: string
  is_shared: boolean
  phone_hint: string | null
  last_connected_at: string | null
  created_at: string
}

export interface CreatePairingInput {
  /** Stable slug; if omitted, the orchestrator generates one from the display_name. */
  id?: string
  kind: string
  display_name: string
  /** Optional absolute path; if omitted, the orchestrator derives `store/auth-<id>/`. */
  auth_path?: string
  /** Defaults to false on the orchestrator side — only the migration row is shared. */
  is_shared?: boolean
  phone_hint?: string | null
}

export interface CreatePairingResult {
  success: boolean
  pairing?: ChannelPairing
  error?: string
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs = 5000
): Promise<Response> {
  const controller = new AbortController()
  const t = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(t)
  }
}

/**
 * GET /api/pairings — returns every channel pairing on the deployment.
 * Empty list (rather than a thrown error) when the orchestrator isn't
 * reachable, because PairingChoiceStep treats "no pairings" as
 * "operator must pair a new one" — same UX as the genuinely-empty case.
 */
export async function listPairings(): Promise<{
  pairings: ChannelPairing[]
  error?: string
}> {
  try {
    const r = await fetchWithTimeout(`${orchestratorUrl()}/api/pairings`, {})
    if (!r.ok) {
      return { pairings: [], error: `HTTP ${r.status}` }
    }
    const body = (await r.json()) as { pairings: ChannelPairing[] }
    return { pairings: body.pairings ?? [] }
  } catch (err) {
    return { pairings: [], error: (err as Error).message }
  }
}

export interface AssignPairingResult {
  success: boolean
  error?: string
}

/**
 * PATCH /api/agents/:id — assign a pairing to an agent.
 *
 * The wizard calls this twice in the per-pairing branch: once to point
 * the freshly-created agent at the new pairing's id, and (in the
 * shared-pairing branch) once to point it at the shared pairing. The
 * orchestrator handles persistence + audit logging + reloadConfig().
 */
export async function assignAgentPairing(
  agentId: string,
  pairingId: string
): Promise<AssignPairingResult> {
  try {
    const r = await fetchWithTimeout(
      `${orchestratorUrl()}/api/agents/${encodeURIComponent(agentId)}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel_pairing_id: pairingId })
      }
    )
    if (!r.ok) {
      const body = (await r.json().catch(() => ({}))) as { error?: string }
      return { success: false, error: body.error ?? `HTTP ${r.status}` }
    }
    return { success: true }
  } catch (err) {
    return { success: false, error: (err as Error).message }
  }
}

/**
 * POST /api/pairings — register a new pairing. Returns the created row
 * including the orchestrator-derived `auth_path` so the wizard can
 * stash it on setup-state for the subsequent WhatsAppStep run.
 */
export async function createPairing(
  input: CreatePairingInput
): Promise<CreatePairingResult> {
  try {
    const r = await fetchWithTimeout(`${orchestratorUrl()}/api/pairings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input)
    })
    const body = (await r.json().catch(() => ({}))) as {
      pairing?: ChannelPairing
      error?: string
    }
    if (!r.ok) {
      return { success: false, error: body.error ?? `HTTP ${r.status}` }
    }
    if (!body.pairing) {
      return { success: false, error: 'orchestrator returned no pairing row' }
    }
    return { success: true, pairing: body.pairing }
  } catch (err) {
    return { success: false, error: (err as Error).message }
  }
}
