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

export interface Group {
  jid: string;
  name: string;
  folder: string;
  trigger?: string;
  added_at?: string;
  requires_trigger: boolean;
  is_main: boolean;
  container_config: Record<string, unknown> | null;
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
  action: string;
  target?: string | null;
  payload_before?: string | null;
  payload_after?: string | null;
  created_at: string;
  reversible_until?: string | null;
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

export async function getGroups(): Promise<Group[]> {
  const res = await getJson<{ groups: Group[] }>('/api/groups');
  return res.groups;
}

export async function getGroup(jid: string): Promise<Group> {
  return getJson<Group>(`/api/groups/${encodeURIComponent(jid)}`);
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
