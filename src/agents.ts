/**
 * Agent CRUD helpers.
 *
 * An Agent is a named entity that owns a persona, a provider, and a memory
 * namespace. Groups belong to agents; the same machine can run multiple
 * agents (Andy on Claude, Ben on Gemini, Echo on Ollama).
 *
 * Schema lives in `src/db.ts`'s `createSchema()` — see the `agents` table
 * and the `agent_id` FK on `registered_groups` and `sessions`.
 *
 * The default agent is synthesised on first orchestrator startup from the
 * existing `ASSISTANT_NAME` / `ANTHROPIC_MODEL` environment so a v1/v2 → v3
 * upgrade is invisible to the operator. See PROVIDER_PLAYBOOK § 10
 * (Migration from Anthropic-only).
 *
 * Gemini blueprint PR 1 — Phase H.2 (agent operations).
 */

import { getDb } from './db.js';
import { logger } from './logger.js';
import type { Agent, MountAllowlist, Provider, RegisteredGroup } from './types.js';

interface AgentRow {
  id: string;
  name: string;
  persona: string | null;
  provider_protocol: string;
  provider_model: string;
  provider_base_url: string | null;
  credential_id: string | null;
  memory_namespace: string;
  default_trigger: string;
  parent_agent_id: string | null;
  is_default: number;
  created_at: string;
  mount_allowlist_override: string | null;
  channel_pairing_id: string | null;
  daily_budget_cents: number | null;
}

function rowToAgent(row: AgentRow): Agent {
  let override: MountAllowlist | null = null;
  if (row.mount_allowlist_override) {
    try {
      override = JSON.parse(row.mount_allowlist_override) as MountAllowlist;
    } catch (err) {
      logger.warn(
        { agentId: row.id, err: (err as Error).message },
        'agents: failed to parse mount_allowlist_override; falling back to deployment allowlist',
      );
    }
  }
  return {
    id: row.id,
    name: row.name,
    persona: row.persona ?? '',
    provider: {
      protocol: row.provider_protocol,
      model: row.provider_model,
      base_url: row.provider_base_url,
      credential_id: row.credential_id,
    },
    memory_namespace: row.memory_namespace,
    default_trigger: row.default_trigger,
    parent_agent_id: row.parent_agent_id,
    is_default: row.is_default === 1,
    created_at: row.created_at,
    mount_allowlist_override: override,
    channel_pairing_id: row.channel_pairing_id,
    daily_budget_cents: row.daily_budget_cents,
  };
}

/**
 * Slugify a display name into a stable agent id. Same rules used by the
 * default-agent migration in `db.ts#synthesiseDefaultAgent`.
 */
export function slugifyAgentId(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '') || 'agent'
  );
}

/**
 * List all agents. Default agent first, then by created_at ascending.
 */
export function listAgents(): Agent[] {
  const rows = getDb()
    .prepare(
      `SELECT id, name, persona, provider_protocol, provider_model,
              provider_base_url, credential_id, memory_namespace,
              default_trigger, parent_agent_id, is_default, created_at,
              mount_allowlist_override, channel_pairing_id, daily_budget_cents
         FROM agents
         ORDER BY is_default DESC, created_at ASC`,
    )
    .all() as AgentRow[];
  return rows.map(rowToAgent);
}

/**
 * Fetch a single agent by id. Returns null if not found — callers decide
 * whether the absence is an error (most callers should fall through to
 * `getDefaultAgent()` rather than 404).
 */
export function getAgent(id: string): Agent | null {
  const row = getDb()
    .prepare(
      `SELECT id, name, persona, provider_protocol, provider_model,
              provider_base_url, credential_id, memory_namespace,
              default_trigger, parent_agent_id, is_default, created_at,
              mount_allowlist_override, channel_pairing_id, daily_budget_cents
         FROM agents WHERE id = ?`,
    )
    .get(id) as AgentRow | undefined;
  return row ? rowToAgent(row) : null;
}

/**
 * Return the default agent for this deployment. There is always exactly
 * one — the schema migration ensures it on first run and `deleteAgent`
 * refuses to remove it without a replacement. Callers can rely on the
 * non-null return.
 */
export function getDefaultAgent(): Agent {
  const row = getDb()
    .prepare(
      `SELECT id, name, persona, provider_protocol, provider_model,
              provider_base_url, credential_id, memory_namespace,
              default_trigger, parent_agent_id, is_default, created_at,
              mount_allowlist_override, channel_pairing_id, daily_budget_cents
         FROM agents WHERE is_default = 1 LIMIT 1`,
    )
    .get() as AgentRow | undefined;
  if (!row) {
    // This shouldn't happen — `createSchema()` synthesises a default
    // agent when the table is empty. Surface loudly if it does, because
    // anything depending on getDefaultAgent() will silently break.
    throw new Error(
      'No default agent in agents table. Run orchestrator startup to ' +
        'synthesise one, or check for a corrupt agents table.',
    );
  }
  return rowToAgent(row);
}

/**
 * Look up the agent by stable id; fall back to the default agent if the
 * id is null/unknown. Used by the container-runner's provider-resolution
 * chain: group.agent_id → that agent, else the deployment's default.
 */
export function getAgentOrDefault(id: string | null | undefined): Agent {
  if (id) {
    const agent = getAgent(id);
    if (agent) return agent;
    logger.warn(
      { requestedId: id },
      'Unknown agent_id; falling back to default agent',
    );
  }
  return getDefaultAgent();
}

/**
 * Resolve the agent that should answer a message in the given group.
 * Implements PROVIDER_PLAYBOOK § 0's resolution rule:
 *
 *   1. group.containerConfig.provider — rarely set (per-group override)
 *      handled by the caller, not here. This helper only looks at agents.
 *   2. group.agent_id → that agent
 *   3. deployment default agent
 *
 * Returns the resolved Agent. The caller is responsible for layering on
 * any per-group `containerConfig.provider` override on top.
 */
export function resolveAgentForGroup(
  group: Pick<RegisteredGroup, 'folder'> & { agent_id?: string | null },
): Agent {
  return getAgentOrDefault(group.agent_id ?? null);
}

/**
 * Per-message trigger override.
 *
 * Scans a message's text for any agent's `default_trigger` prefix. If a
 * non-default agent's trigger matches, the message is dispatched to *that*
 * agent's container — regardless of which agent the group is assigned to.
 *
 * Example: a group is assigned to Andy (Claude). The operator types
 * "@Ben what's the weather?" in that group. This helper returns Ben.
 * Ben's container handles the turn; Andy stays untouched.
 *
 * Returns:
 *   - The matched agent, when exactly one agent's trigger appears in
 *     the message text.
 *   - `null` when no agent trigger matches — the caller falls back to
 *     the group's assigned agent via `resolveAgentForGroup`.
 *
 * Implements PROVIDER_PLAYBOOK § 0 + Gemini blueprint § 9.5.3 (Phase H.3).
 */
export function resolveAgentByTrigger(messageText: string): Agent | null {
  if (!messageText) return null;
  const agents = listAgents();
  if (agents.length <= 1) return null; // No second agent to dispatch to.

  // Match `@<name>` at the start of the message, case-insensitive,
  // followed by whitespace, punctuation, or end-of-string. We don't try
  // to match mid-message mentions — operators sending "@Andy say hi"
  // unambiguously address Andy; "I told @Andy yesterday" should not.
  const trimmed = messageText.trim();
  if (!trimmed.startsWith('@')) return null;

  for (const agent of agents) {
    const trigger = agent.default_trigger.trim();
    if (!trigger || !trigger.startsWith('@')) continue;
    // Word-boundary-safe match: trigger followed by whitespace, EOL,
    // or common punctuation. Case-insensitive so `@andy` works too.
    const pattern = new RegExp(
      `^${escapeRegex(trigger)}(?=\\s|[\\.,!?;:]|$)`,
      'i',
    );
    if (pattern.test(trimmed)) {
      return agent;
    }
  }
  return null;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Resolve the *provider* that should answer a message in the given group.
 * Applies the per-group override (when present) on top of the agent's
 * provider. This is the entry point used by `container-runner.ts`.
 */
export function resolveProviderForGroup(
  group: RegisteredGroup & { agent_id?: string | null },
): Provider {
  if (group.containerConfig?.provider) {
    return group.containerConfig.provider;
  }
  const agent = resolveAgentForGroup(group);
  return agent.provider;
}

export interface CreateAgentInput {
  id?: string; // Defaults to slugified name; must be unique
  name: string;
  persona?: string;
  provider: Provider;
  memory_namespace?: string; // Defaults to `agents/<id>`
  default_trigger?: string; // Defaults to `@<name>`
  parent_agent_id?: string | null;
  is_default?: boolean;
}

/**
 * Create a new agent. If `is_default: true`, demotes the current default.
 * Returns the inserted Agent (id derived from name if not supplied).
 */
export function createAgent(input: CreateAgentInput): Agent {
  const id = input.id ?? slugifyAgentId(input.name);
  if (getAgent(id)) {
    throw new Error(`Agent with id '${id}' already exists`);
  }
  const memory_namespace = input.memory_namespace ?? `agents/${id}`;
  const default_trigger = input.default_trigger ?? `@${input.name}`;
  const created_at = new Date().toISOString();
  const isDefault = input.is_default === true;

  const db = getDb();
  const tx = db.transaction(() => {
    if (isDefault) {
      // Exactly one row carries is_default = 1.
      db.prepare(`UPDATE agents SET is_default = 0 WHERE is_default = 1`).run();
    }
    db.prepare(
      `INSERT INTO agents
         (id, name, persona, provider_protocol, provider_model,
          provider_base_url, credential_id, memory_namespace,
          default_trigger, parent_agent_id, is_default, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.name,
      input.persona ?? '',
      input.provider.protocol,
      input.provider.model,
      input.provider.base_url,
      input.provider.credential_id,
      memory_namespace,
      default_trigger,
      input.parent_agent_id ?? null,
      isDefault ? 1 : 0,
      created_at,
    );
  });
  tx();

  const agent = getAgent(id);
  if (!agent) throw new Error(`createAgent: insert succeeded but read missed`);
  logger.info(
    {
      agent: agent.id,
      provider: agent.provider.protocol,
      isDefault,
    },
    'Created agent',
  );
  return agent;
}

export interface UpdateAgentPatch {
  name?: string;
  persona?: string;
  provider?: Provider;
  default_trigger?: string;
  parent_agent_id?: string | null;
  channel_pairing_id?: string | null;
  /** Cents per day. Null clears the cap. */
  daily_budget_cents?: number | null;
  /** Stringified MountAllowlist JSON. Null clears the override. */
  mount_allowlist_override?: string | null;
}

/**
 * Update an existing agent. Only supplied fields are touched. Renaming an
 * agent does NOT change its id (the id is the stable handle the schema
 * keys on); display name updates everywhere via the rolling display.
 */
export function updateAgent(id: string, patch: UpdateAgentPatch): Agent {
  const existing = getAgent(id);
  if (!existing) throw new Error(`Unknown agent id: ${id}`);

  const next: Agent = {
    ...existing,
    name: patch.name ?? existing.name,
    persona: patch.persona ?? existing.persona,
    provider: patch.provider ?? existing.provider,
    default_trigger: patch.default_trigger ?? existing.default_trigger,
    parent_agent_id:
      patch.parent_agent_id !== undefined
        ? patch.parent_agent_id
        : existing.parent_agent_id,
    channel_pairing_id:
      patch.channel_pairing_id !== undefined
        ? patch.channel_pairing_id
        : existing.channel_pairing_id,
    daily_budget_cents:
      patch.daily_budget_cents !== undefined
        ? patch.daily_budget_cents
        : existing.daily_budget_cents,
  };

  // mount_allowlist_override accepts a stringified JSON blob; if the
  // patch carries it, persist verbatim so the round-trip through
  // rowToAgent reads it back as a parsed MountAllowlist.
  const allowlistJson =
    patch.mount_allowlist_override !== undefined
      ? patch.mount_allowlist_override
      : existing.mount_allowlist_override
        ? JSON.stringify(existing.mount_allowlist_override)
        : null;

  getDb()
    .prepare(
      `UPDATE agents SET
         name = ?,
         persona = ?,
         provider_protocol = ?,
         provider_model = ?,
         provider_base_url = ?,
         credential_id = ?,
         default_trigger = ?,
         parent_agent_id = ?,
         channel_pairing_id = ?,
         daily_budget_cents = ?,
         mount_allowlist_override = ?
       WHERE id = ?`,
    )
    .run(
      next.name,
      next.persona,
      next.provider.protocol,
      next.provider.model,
      next.provider.base_url,
      next.provider.credential_id,
      next.default_trigger,
      next.parent_agent_id,
      next.channel_pairing_id ?? null,
      next.daily_budget_cents ?? null,
      allowlistJson,
      id,
    );

  return next;
}

/**
 * Delete an agent. Groups and sessions belonging to this agent are
 * reassigned to the deployment's default agent — we never orphan rows.
 * Refuses to delete the default agent (caller must promote a replacement
 * first via `setDefaultAgent`).
 */
export function deleteAgent(id: string): void {
  const agent = getAgent(id);
  if (!agent) throw new Error(`Unknown agent id: ${id}`);
  if (agent.is_default) {
    throw new Error(
      `Cannot delete the default agent. Promote another agent first.`,
    );
  }
  const defaultAgent = getDefaultAgent();
  const db = getDb();
  const tx = db.transaction(() => {
    db.prepare(`UPDATE registered_groups SET agent_id = ? WHERE agent_id = ?`)
      .run(defaultAgent.id, id);
    db.prepare(`UPDATE sessions SET agent_id = ? WHERE agent_id = ?`)
      .run(defaultAgent.id, id);
    db.prepare(`DELETE FROM agents WHERE id = ?`).run(id);
  });
  tx();
  logger.info(
    { deletedAgent: id, reassignedTo: defaultAgent.id },
    'Deleted agent and reassigned its groups/sessions',
  );
}

/**
 * Promote a new default agent. Demotes the current one in the same
 * transaction so the invariant "exactly one default row" holds.
 */
export function setDefaultAgent(id: string): void {
  const target = getAgent(id);
  if (!target) throw new Error(`Unknown agent id: ${id}`);
  const db = getDb();
  const tx = db.transaction(() => {
    db.prepare(`UPDATE agents SET is_default = 0 WHERE is_default = 1`).run();
    db.prepare(`UPDATE agents SET is_default = 1 WHERE id = ?`).run(id);
  });
  tx();
  logger.info({ newDefault: id }, 'Promoted default agent');
}
