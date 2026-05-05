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
  platform: string;
  brain_path?: string | null;
}

export interface Health {
  machine: MachineIdentity & { brain_path?: string | null };
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
  id: number;
  group_folder: string;
  started_at: string;
  finished_at?: string | null;
  duration_ms?: number | null;
  model?: string | null;
  input_tokens?: number | null;
  output_tokens?: number | null;
  est_cost_cents?: number | null;
  error?: string | null;
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
  since?: string;
  limit?: number;
}

export async function getTurns(opts: GetTurnsOpts = {}): Promise<Turn[]> {
  const params = new URLSearchParams();
  if (opts.group) params.set('group', opts.group);
  if (opts.since) params.set('since', opts.since);
  if (opts.limit !== undefined) params.set('limit', String(opts.limit));
  const qs = params.toString();
  const res = await getJson<{ turns: Turn[] }>(
    `/api/turns${qs ? '?' + qs : ''}`,
  );
  return res.turns;
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
