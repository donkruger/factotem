// Translate raw backend/network errors into operator-actionable copy.
//
// Why this exists: wizard steps that call a backend service (the
// orchestrator's HTTP API on :7842, the OneCLI gateway on :10254, the
// Docker socket) fail with low-level strings the operator can't act on
// — "fetch failed", "ECONNREFUSED", "Failed to fetch", AbortError, etc.
// Per the service-dependency remediation philosophy in this package's
// CLAUDE.md, a step must translate-don't-leak: detect the connection
// class and render a "service down — here's how to start it" affordance
// instead of the raw string. This is the single classifier those steps
// share so the detection stays consistent.

export interface ServiceErrorInfo {
  /** True when the failure is the dependency being unreachable (vs. a real app error). */
  isConnectionError: boolean
  title: string
  detail: string
  /** Shell command that brings the orchestrator back up (for the copy / Terminal fallback). */
  command: string
}

// Lower-cased substrings that indicate the orchestrator/gateway is
// simply not listening, rather than a genuine application error. Node's
// undici surfaces a refused TCP connect as "fetch failed"; browsers as
// "Failed to fetch"; aborted timeouts as "aborted"/"AbortError".
const CONNECTION_PATTERNS = [
  'fetch failed',
  'failed to fetch',
  'econnrefused',
  'connection refused',
  'network error',
  'load failed',
  'socket hang up',
  'enotfound',
  'eai_again',
  'the operation was aborted',
  'aborterror',
  'timeout',
  'timed out'
]

export function isConnectionError(raw: string | null | undefined): boolean {
  if (!raw) return false
  const s = raw.toLowerCase()
  return CONNECTION_PATTERNS.some((p) => s.includes(p))
}

// `$(id -u)` keeps the command copy-pasteable on any operator's machine
// without us having to thread their uid through to the renderer.
export const ORCHESTRATOR_START_COMMAND =
  'launchctl kickstart -k gui/$(id -u)/com.nanoclaw'

export function describeServiceError(
  raw: string | null | undefined
): ServiceErrorInfo {
  if (isConnectionError(raw)) {
    return {
      isConnectionError: true,
      title: "The NanoClaw orchestrator isn't reachable",
      detail:
        'The setup app reads and creates WhatsApp pairings through the ' +
        "orchestrator's local API (http://127.0.0.1:7842). That API isn't " +
        "responding right now, so this step can't continue until the " +
        'orchestrator is running.',
      command: ORCHESTRATOR_START_COMMAND
    }
  }
  return {
    isConnectionError: false,
    title: 'Something went wrong',
    detail: raw ?? 'Unknown error.',
    command: ORCHESTRATOR_START_COMMAND
  }
}
