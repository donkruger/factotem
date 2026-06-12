/**
 * Type-safe client for the NanoClaw HTTP API mounted alongside this static
 * export. The dashboard is served from the same origin as `/api/*` and
 * `/health`, so BASE defaults to '' (relative). Override via
 * NEXT_PUBLIC_NANOCLAW_URL when developing the dashboard standalone
 * (e.g. against a remote NanoClaw via Tailscale).
 */

const BASE = process.env.NEXT_PUBLIC_NANOCLAW_URL ?? '';

// ──────────────────────────────────────────────────────────────────────────
// Response shapes — mirrors of the backend types in
// `nanoclaw/src/http/{health,api}.ts`. Kept as a duplicate definition (rather
// than a shared module import) because the dashboard is built standalone and
// fetches via HTTP at runtime — there is no shared compile-time dependency
// on the orchestrator's TypeScript.
// ──────────────────────────────────────────────────────────────────────────

export interface MachineIdentity {
  id: string;
  hostname: string;
  region: string;
  brain_path?: string | null;
  created_at?: string;
}

export interface Health {
  machine: MachineIdentity & { tailscale_ip: string | null };
  nanoclaw: {
    running: true;
    pid: number;
    uptime_seconds: number;
    version: string;
  };
  docker: {
    running: boolean;
    containers_active: number;
    image_tag: string | null;
    /**
     * Global MAX_CONCURRENT_CONTAINERS cap surfaced for dashboard
     * rendering of `concurrent_at_spawn` as `N / max`.
     * v1.2.1-finish-blueprint § 3.
     */
    max_concurrent?: number;
  };
  onecli: {
    reachable: boolean;
    latency_ms: number | null;
    auth_mode: string | null;
  };
  whatsapp: {
    authenticated: boolean;
    last_message_at: string | null;
  };
  open_dm: {
    enabled: boolean;
    daily_budget_cents: number | null;
    today_spent_cents: number;
  };
}

export interface Provider {
  protocol: string;
  model: string;
  base_url: string | null;
  credential_id: string | null;
}

/**
 * Agent — mirrors `nanoclaw/src/types.ts#Agent`. Duplicated here per the
 * dashboard's convention (no compile-time shared types; runtime HTTP only).
 * See docs/PROVIDER_PLAYBOOK.md § 0 for the canonical taxonomy.
 */
export interface Agent {
  id: string;
  name: string;
  persona: string;
  provider: Provider;
  memory_namespace: string;
  default_trigger: string;
  parent_agent_id: string | null;
  is_default: boolean;
  created_at: string;
  /** Returned by /api/agents — count of registered_groups assigned to this agent. */
  active_group_count?: number;
  /** Returned by /api/agents — today's est_cost_cents summed across the agent's groups. */
  cost_today_cents?: number;
  /** Multi-agent-completion § 4.1 — channel pairing this agent uses. */
  channel_pairing_id?: string | null;
  /** Multi-agent-completion § 4.2 — daily budget cap in cents. Null = unbounded. */
  daily_budget_cents?: number | null;
}

/** Channel pairing summary (multi-agent-completion § 4.1). */
export interface ChannelPairing {
  id: string;
  kind: string;
  display_name: string;
  auth_path: string;
  is_shared: boolean;
  phone_hint: string | null;
  last_connected_at: string | null;
  created_at: string;
}

/**
 * /api/agents/:id detail — extends Agent with the groups it owns. */
export interface AgentDetail extends Agent {
  groups: Array<{
    jid: string;
    name: string;
    folder: string;
    trigger?: string;
    is_main: boolean;
  }>;
  /** Joined pairing (multi-agent-completion § 4.1). Null only for legacy rows pre-migration. */
  pairing?: ChannelPairing | null;
  /** Today's cumulative spend in cents (multi-agent-completion § 4.2). */
  spent_today_cents?: number;
}

export interface Group {
  jid: string;
  name: string;
  folder: string;
  trigger?: string;
  added_at?: string;
  requires_trigger: boolean;
  is_main: boolean;
  container_config: Record<string, unknown> | null;
  /** Resolved agent id — nullable for legacy rows before migration. */
  agent_id?: string | null;
  /** Joined agent metadata for chip rendering (Phase E.1). */
  agent?: {
    id: string;
    name: string;
    provider: Provider;
  } | null;
  /** Resolved provider — per-group override → agent → default. */
  provider?: Provider | null;
}

export interface Turn {
  // Mirrors AgentTurnRow in nanoclaw/src/db.ts. Optional fields stay
  // optional because the underlying schema is additive (new columns
  // landed in Wave 2 with NULL defaults for backfill safety).
  turn_id: string;
  machine_id: string;
  group_folder: string;
  group_jid?: string | null;
  agent_profile?: string | null;
  model: string;
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  est_cost_cents?: number | null;
  started_at: string;
  finished_at: string;
  duration_ms: number;
  duration_api_ms?: number | null;
  ttft_ms?: number | null;
  tool_use_count?: number;
  tool_error_count?: number;
  retry_count?: number;
  compaction_count?: number;
  num_turns?: number | null;
  exit_code?: number | null;
  outcome: 'success' | 'error' | 'budget_capped';
  error_class?: string | null;
  prompt_chars?: number | null;
  response_chars?: number | null;
  session_id?: string | null;
  is_main?: number;
  is_scheduled_task?: number;
  attachment_count?: number;
  truncated_output?: number;
  /**
   * Agent that actually answered this turn. Differs from the group's
   * assigned agent when a per-message @<trigger> dispatched to a
   * non-default agent. Nullable for pre-v1.2.1 rows. See
   * multi-agent-completion-blueprint § 3.2.
   */
  responder_agent_id?: string | null;
  /**
   * Milliseconds the turn waited in the per-group FIFO before its
   * container spawned. NULL on pre-v1.2.1 rows. v1.2.1-finish § 3.
   */
  queue_wait_ms?: number | null;
  /**
   * How many containers were already running when this one spawned.
   * NULL on pre-v1.2.1 rows. v1.2.1-finish § 3.
   */
  concurrent_at_spawn?: number | null;
}

export interface MessageHit {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string | null;
  content: string;
  timestamp: string;
  is_from_me: number;
  is_bot_message: number;
}

export interface CostDaily {
  day: string;
  model: string;
  cents: number;
  in_tok: number;
  out_tok: number;
  turns: number;
}

export interface AuditEntry {
  id: number;
  machine_id: string;
  ts: string;
  actor: string;
  action: string;
  target?: string | null;
  payload_before?: string | null;
  payload_after?: string | null;
  reversible_until?: string | null;
}

export type AlertSeverity = 'critical' | 'warning' | 'info';

export interface Alert {
  id:
    | 'docker_wedge'
    | 'error_string_in_reply'
    | 'auth_mode_freshness'
    | 'ghost_action_divergence'
    | 'wa_respawn_counter';
  severity: AlertSeverity;
  title: string;
  detail: string;
  recommendation?: string;
  recovery_url?: string;
  recovery_action?: 'restart_stack';
  detected_at: string;
}

export interface AlertsResponse {
  alerts: Alert[];
  restart_stack_enabled: boolean;
  detected_at: string;
}

// ──────────────────────────────────────────────────────────────────────────
// Fetch helpers
// ──────────────────────────────────────────────────────────────────────────

class HttpError extends Error {
  constructor(
    public status: number,
    public body: string,
    url: string,
  ) {
    super(`HTTP ${status} from ${url}: ${body.slice(0, 200)}`);
    this.name = 'HttpError';
  }
}

async function getJson<T>(path: string): Promise<T> {
  const url = `${BASE}${path}`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new HttpError(res.status, body, url);
  }
  return res.json() as Promise<T>;
}

// ──────────────────────────────────────────────────────────────────────────
// Endpoint wrappers
// ──────────────────────────────────────────────────────────────────────────

export async function getHealth(): Promise<Health> {
  return getJson<Health>('/health');
}

/**
 * True when the deployment authenticates Anthropic via a subscription /
 * OAuth token rather than a metered API key. In these modes there is no
 * per-token dollar billing (the plan is flat, and from 2026-06-15 a capped
 * monthly Agent-SDK credit), so the dashboard pivots cost panels to token
 * usage instead of dollars. Mirrors `anthropicUsesBearerAuth()` in
 * src/container-runner.ts (subscription | oauth-workaround), and also
 * accepts a bare `oauth` marker for forward-compatibility.
 *
 * Reads `Health.onecli.auth_mode`, the raw value of
 * `~/.config/nanoclaw/auth-mode` surfaced by the orchestrator.
 */
export function isUsageMode(authMode: string | null | undefined): boolean {
  return (
    authMode === 'subscription' ||
    authMode === 'oauth-workaround' ||
    authMode === 'oauth'
  );
}

export async function getGroups(): Promise<Group[]> {
  const res = await getJson<{ groups: Group[] }>('/api/groups');
  return res.groups;
}

export async function getGroup(jid: string): Promise<Group> {
  return getJson<Group>(`/api/groups/${encodeURIComponent(jid)}`);
}

export interface PersonaGroup {
  jid: string;
  name: string;
  folder: string;
  trigger?: string;
  is_main: boolean;
}

export interface Persona {
  assistant_name: string;
  default_trigger: string;
  groups: PersonaGroup[];
}

export async function getPersona(): Promise<Persona> {
  return getJson<Persona>('/api/persona');
}

export async function getAgents(): Promise<Agent[]> {
  const res = await getJson<{ agents: Agent[] }>('/api/agents');
  return res.agents;
}

export async function getAgent(id: string): Promise<AgentDetail> {
  return getJson<AgentDetail>(`/api/agents/${encodeURIComponent(id)}`);
}

/**
 * Generic agent patch (multi-agent-completion § 4.1 + § 4.2). Used by
 * the dashboard to change pairing, budget, persona, etc. The
 * provider-switch flow uses the dedicated POST /provider endpoint
 * because it has its own audit class.
 */
export async function patchAgent(
  agentId: string,
  patch: Partial<{
    name: string;
    persona: string;
    default_trigger: string;
    channel_pairing_id: string | null;
    daily_budget_cents: number | null;
    mount_allowlist_override: string | null;
  }>,
): Promise<{ ok: true; audit_id: number | null; agent: Agent }> {
  const url = `${BASE}/api/agents/${encodeURIComponent(agentId)}`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new HttpError(res.status, body, url);
  }
  return res.json();
}

export async function getPairings(): Promise<ChannelPairing[]> {
  const res = await getJson<{ pairings: ChannelPairing[] }>('/api/pairings');
  return res.pairings;
}

/** Probe orphaned credentials (multi-agent-completion § 5.1). */
export async function getOrphanedCredentials(): Promise<string[]> {
  const res = await getJson<{ candidates: string[] }>(
    '/api/credentials/orphaned',
  );
  return res.candidates;
}

/**
 * Destructive credential delete (v1.2.1-finish § 4). Should only be
 * called from inside a typed-confirm modal; the endpoint defends
 * against accidental triggers with a 409 if the credential is
 * still referenced.
 */
export async function deleteCredential(
  name: string,
): Promise<{ ok: true; audit_id: number }> {
  const url = `${BASE}/api/credentials/${encodeURIComponent(name)}`;
  const res = await fetch(url, { method: 'DELETE' });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new HttpError(res.status, body, url);
  }
  return res.json();
}

export async function createPairing(args: {
  kind: string;
  display_name: string;
  phone_hint?: string | null;
}): Promise<{ ok: true; pairing: ChannelPairing; audit_id: number }> {
  const url = `${BASE}/api/pairings`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(args),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new HttpError(res.status, body, url);
  }
  return res.json();
}

// --- Provider registry surface (PR 5 — ModelSwitchModal target picker) ---

export interface ProviderRegistryEntry {
  name: string;
  tagline: string;
  wire_protocol: 'anthropic' | 'openai-compatible';
  base_url: string;
  auth_kind: 'api-key' | 'none' | 'oauth';
  default_model: string;
  models_endpoint: string;
  key_signup_url?: string;
  key_format_hint?: string;
  onecli: {
    name: string;
    host_pattern: string;
    header_name: string;
    value_format: string;
  } | null;
  capabilities: {
    tool_use: string;
    vision: boolean;
    computer_use: boolean;
    prompt_caching: boolean;
    long_context: boolean;
    local: boolean;
  };
  container_image: string;
  ships_in: string;
  cost_hint: string;
}

/**
 * Fetch the canonical provider registry from the orchestrator's
 * `setup/providers.json`. Adding a 9th provider is a JSON edit that
 * propagates here on the next dashboard reload.
 *
 * Falls back to a hard-coded Anthropic+Gemini snapshot if the network
 * call fails — the dashboard never blocks rendering on the registry
 * being reachable, only on it being out-of-date.
 */
export async function getProviderRegistry(): Promise<
  Record<string, ProviderRegistryEntry>
> {
  try {
    const res = await getJson<{
      providers: Record<string, ProviderRegistryEntry>;
    }>('/api/providers');
    return res.providers;
  } catch (err) {
    // Network or 5xx error — fall back to the bundled snapshot so the
    // ModelSwitchModal still renders. The dashboard surfaces the
    // network failure separately via ConnectionLossBanner on pages
    // that poll. Bundled fallback mirrors setup/providers.json on the
    // day this dashboard was built; refresh when providers.json
    // changes.
    if (typeof console !== 'undefined') {
      console.warn(
        '[nanoclaw] /api/providers unreachable; using bundled fallback.',
        err,
      );
    }
    return BUNDLED_REGISTRY_FALLBACK;
  }
}

/** Last-resort fallback when /api/providers can't be reached. */
const BUNDLED_REGISTRY_FALLBACK: Record<string, ProviderRegistryEntry> = {
  anthropic: {
    name: 'Anthropic Claude',
    tagline: 'Strongest agentic quality. The default.',
    wire_protocol: 'anthropic',
    base_url: 'https://api.anthropic.com',
    auth_kind: 'api-key',
    default_model: 'claude-opus-4-6',
    models_endpoint: 'https://api.anthropic.com/v1/models',
    key_signup_url: 'https://console.anthropic.com/settings/keys',
    key_format_hint: 'Starts with sk-ant-',
    onecli: {
      name: 'Anthropic',
      host_pattern: 'api.anthropic.com',
      header_name: 'x-api-key',
      value_format: '{value}',
    },
    capabilities: {
      tool_use: 'best',
      vision: true,
      computer_use: true,
      prompt_caching: true,
      long_context: true,
      local: false,
    },
    container_image: 'nanoclaw-agent',
    ships_in: 'v1.0',
    cost_hint: 'Roughly $2-4/day for a chatty WhatsApp group',
  },
  gemini: {
    name: 'Google Gemini',
    tagline: 'Generous free tier. Long context up to 2M tokens.',
    wire_protocol: 'openai-compatible',
    base_url: 'https://generativelanguage.googleapis.com/v1beta/openai',
    auth_kind: 'api-key',
    default_model: 'gemini-2.5-pro',
    models_endpoint:
      'https://generativelanguage.googleapis.com/v1beta/openai/models',
    key_signup_url: 'https://aistudio.google.com/app/apikey',
    key_format_hint:
      'Long alphanumeric string from Google AI Studio, often starting with AIza',
    onecli: {
      name: 'Gemini',
      host_pattern: 'generativelanguage.googleapis.com',
      header_name: 'Authorization',
      value_format: 'Bearer {value}',
    },
    capabilities: {
      tool_use: 'strong',
      vision: true,
      computer_use: false,
      prompt_caching: false,
      long_context: true,
      local: false,
    },
    container_image: 'nanoclaw-agent-oai',
    ships_in: 'v1.2',
    cost_hint:
      'Free tier covers light personal use. Paid: ~$0.50-2/day for chatty groups.',
  },
};

/**
 * Commit a provider switch for an agent. Returns the updated agent;
 * surfaces audit_id so the dashboard can deep-link the undo.
 */
export async function switchAgentProvider(
  agentId: string,
  provider: Provider,
): Promise<{ ok: true; audit_id: number; agent: Agent }> {
  const url = `${BASE}/api/agents/${encodeURIComponent(agentId)}/provider`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(provider),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new HttpError(res.status, body, url);
  }
  return res.json();
}

export interface SandboxTestResult {
  ok: boolean;
  audit_id: number;
  reply: string;
  model: string;
  cost_micros?: number;
  stub?: boolean;
}

/**
 * Send a sandboxed test message against a proposed provider. Does not
 * mutate the agent's current assignment. PR 5 ships a stub backend;
 * PR 6 wires a real throwaway-container spawn behind the same shape.
 */
export async function sandboxTestAgent(
  agentId: string,
  args: { protocol: string; model: string; prompt: string },
): Promise<SandboxTestResult> {
  const url = `${BASE}/api/agents/${encodeURIComponent(agentId)}/sandbox-test`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(args),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new HttpError(res.status, body, url);
  }
  return res.json();
}

export interface GetTurnsOpts {
  group?: string;
  model?: string;
  outcome?: 'success' | 'error' | 'budget_capped';
  since?: string;
  limit?: number;
}

function turnsQs(opts: GetTurnsOpts): URLSearchParams {
  const params = new URLSearchParams();
  if (opts.group) params.set('group', opts.group);
  if (opts.model) params.set('model', opts.model);
  if (opts.outcome) params.set('outcome', opts.outcome);
  if (opts.since) params.set('since', opts.since);
  if (opts.limit !== undefined) params.set('limit', String(opts.limit));
  return params;
}

export async function getTurns(opts: GetTurnsOpts = {}): Promise<Turn[]> {
  const qs = turnsQs(opts).toString();
  const res = await getJson<{ turns: Turn[] }>(
    `/api/turns${qs ? '?' + qs : ''}`,
  );
  return res.turns;
}

/**
 * Build the URL for a CSV export of turns matching the supplied filters.
 * The browser handles the actual download (Content-Disposition header is
 * set server-side). Caller is expected to set this on an `<a download>`.
 */
export function turnsCsvUrl(opts: GetTurnsOpts = {}): string {
  const params = turnsQs(opts);
  params.set('format', 'csv');
  // CSV gets a higher row cap on the server (5000); raise the default
  // here so the operator gets the full window unless they say otherwise.
  if (!params.has('limit')) params.set('limit', '5000');
  return `${BASE}/api/turns?${params.toString()}`;
}

export interface SearchMessagesOpts {
  q: string;
  group?: string;
  limit?: number;
}

export async function searchMessages(
  opts: SearchMessagesOpts,
): Promise<MessageHit[]> {
  const params = new URLSearchParams();
  params.set('q', opts.q);
  if (opts.group) params.set('group', opts.group);
  if (opts.limit !== undefined) params.set('limit', String(opts.limit));
  const res = await getJson<{ messages: MessageHit[] }>(
    `/api/messages/search?${params.toString()}`,
  );
  return res.messages;
}

export interface GetCostDailyOpts {
  group?: string;
  model?: string;
  days?: number;
}

export async function getCostDaily(
  opts: GetCostDailyOpts = {},
): Promise<CostDaily[]> {
  const params = new URLSearchParams();
  if (opts.group) params.set('group', opts.group);
  if (opts.model) params.set('model', opts.model);
  if (opts.days !== undefined) params.set('days', String(opts.days));
  const qs = params.toString();
  const res = await getJson<{ rows: CostDaily[] }>(
    `/api/cost/daily${qs ? '?' + qs : ''}`,
  );
  return res.rows;
}

export interface GetAuditOpts {
  limit?: number;
}

export async function getAudit(opts: GetAuditOpts = {}): Promise<AuditEntry[]> {
  const params = new URLSearchParams();
  if (opts.limit !== undefined) params.set('limit', String(opts.limit));
  const qs = params.toString();
  const res = await getJson<{ entries: AuditEntry[] }>(
    `/api/audit${qs ? '?' + qs : ''}`,
  );
  return res.entries;
}

// ──────────────────────────────────────────────────────────────────────────
// Mutating helpers for the Group Management + Cost Tracking panels
// ──────────────────────────────────────────────────────────────────────────

export interface MutationResult {
  ok: true;
  audit_id: number;
  version: number;
}

async function send<T>(
  method: 'PATCH' | 'POST' | 'DELETE',
  path: string,
  body: unknown | undefined,
  ifMatch: number | undefined,
): Promise<T> {
  const url = `${BASE}${path}`;
  const headers: Record<string, string> = {
    Accept: 'application/json',
  };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (ifMatch !== undefined) headers['If-Match'] = String(ifMatch);
  const res = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new HttpError(res.status, errBody, url);
  }
  return res.json() as Promise<T>;
}

export interface PatchGroupBody {
  requires_trigger?: boolean;
  container_config?: Record<string, unknown>;
  name?: string;
  trigger?: string;
}

export async function patchGroup(
  jid: string,
  body: PatchGroupBody,
  version: number,
): Promise<MutationResult> {
  return send<MutationResult>(
    'PATCH',
    `/api/groups/${encodeURIComponent(jid)}`,
    body,
    version,
  );
}

export async function disableGroup(
  jid: string,
  version: number,
): Promise<MutationResult> {
  return send<MutationResult>(
    'POST',
    `/api/groups/${encodeURIComponent(jid)}/disable`,
    undefined,
    version,
  );
}

export async function enableGroup(
  jid: string,
  version: number,
): Promise<MutationResult> {
  return send<MutationResult>(
    'POST',
    `/api/groups/${encodeURIComponent(jid)}/enable`,
    undefined,
    version,
  );
}

export async function deleteGroup(
  jid: string,
  version: number,
): Promise<MutationResult> {
  return send<MutationResult>(
    'DELETE',
    `/api/groups/${encodeURIComponent(jid)}`,
    undefined,
    version,
  );
}

export interface TestCostAlertBody {
  threshold_pct?: number;
  spent_cents?: number;
  budget_cents?: number;
}

export async function postCostTestAlert(
  body: TestCostAlertBody = {},
): Promise<{ ok: true; audit_id: number; target_folder: string }> {
  return send('POST', '/api/cost/test-alert', body, undefined);
}

// ──────────────────────────────────────────────────────────────────────────
// Alerts + audit-undo + Restart Stack (Wave 7)
// ──────────────────────────────────────────────────────────────────────────

export async function getAlerts(): Promise<AlertsResponse> {
  return getJson<AlertsResponse>('/api/alerts');
}

export interface RestartStackResult {
  ok: true;
  audit_id: number;
  results: { command: string; ok: boolean; detail?: string }[];
}

export async function postRestartStack(): Promise<RestartStackResult> {
  return send<RestartStackResult>('POST', '/api/restart-stack', undefined, undefined);
}

export interface AuditUndoResult {
  ok: true;
  audit_id: number;
  undid: number;
}

export async function postAuditUndo(id: number): Promise<AuditUndoResult> {
  return send<AuditUndoResult>(
    'POST',
    `/api/audit/${id}/undo`,
    undefined,
    undefined,
  );
}

/**
 * Helper: read the optimistic-concurrency version off a Group's
 * container_config. Mirrors the server-side `groupVersion()` helper
 * in `src/http/api.ts`. Defaults to 0 when absent.
 */
export function groupVersionOf(group: Group): number {
  const v = (group.container_config as Record<string, unknown> | null)?.[
    'version'
  ];
  return typeof v === 'number' ? v : 0;
}

/**
 * Helper: a group is "deleted" if its container_config carries a
 * `deleted_at` timestamp. The orchestrator's routing map drops these,
 * but they remain in SQLite for v1.5 restore.
 */
export function isGroupDeleted(group: Group): boolean {
  const t = (group.container_config as Record<string, unknown> | null)?.[
    'deleted_at'
  ];
  return typeof t === 'string' && t.length > 0;
}

export function isGroupDisabled(group: Group): boolean {
  const d = (group.container_config as Record<string, unknown> | null)?.[
    'disabled'
  ];
  return d === true;
}
