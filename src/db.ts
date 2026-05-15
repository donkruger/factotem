import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { ASSISTANT_NAME, DATA_DIR, STORE_DIR } from './config.js';
import { isValidGroupFolder } from './group-folder.js';
import { logger } from './logger.js';
import {
  NewMessage,
  RegisteredGroup,
  ScheduledTask,
  TaskRunLog,
} from './types.js';

let db: Database.Database;

function createSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS chats (
      jid TEXT PRIMARY KEY,
      name TEXT,
      last_message_time TEXT,
      channel TEXT,
      is_group INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT,
      chat_jid TEXT,
      sender TEXT,
      sender_name TEXT,
      content TEXT,
      timestamp TEXT,
      is_from_me INTEGER,
      is_bot_message INTEGER DEFAULT 0,
      PRIMARY KEY (id, chat_jid),
      FOREIGN KEY (chat_jid) REFERENCES chats(jid)
    );
    CREATE INDEX IF NOT EXISTS idx_timestamp ON messages(timestamp);

    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      prompt TEXT NOT NULL,
      schedule_type TEXT NOT NULL,
      schedule_value TEXT NOT NULL,
      next_run TEXT,
      last_run TEXT,
      last_result TEXT,
      status TEXT DEFAULT 'active',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_next_run ON scheduled_tasks(next_run);
    CREATE INDEX IF NOT EXISTS idx_status ON scheduled_tasks(status);

    CREATE TABLE IF NOT EXISTS task_run_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      run_at TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      status TEXT NOT NULL,
      result TEXT,
      error TEXT,
      FOREIGN KEY (task_id) REFERENCES scheduled_tasks(id)
    );
    CREATE INDEX IF NOT EXISTS idx_task_run_logs ON task_run_logs(task_id, run_at);

    CREATE TABLE IF NOT EXISTS router_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      group_folder TEXT PRIMARY KEY,
      session_id TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS registered_groups (
      jid TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      folder TEXT NOT NULL UNIQUE,
      trigger_pattern TEXT NOT NULL,
      added_at TEXT NOT NULL,
      container_config TEXT,
      requires_trigger INTEGER DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS open_rate_buckets (
      sender_jid TEXT PRIMARY KEY,
      tokens REAL NOT NULL,
      last_refill TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS open_spend_log (
      date TEXT PRIMARY KEY,
      container_count INTEGER NOT NULL DEFAULT 0,
      est_cost_cents INTEGER NOT NULL DEFAULT 0
    );
    -- Per-turn telemetry record. Phase 0.2 of the Factotem Dashboard v1
    -- epic (T-1778234000000). 30-column schema per Round 8 of the
    -- overnight research. Backed by SDK usage events emitted in the
    -- container-runner OUTPUT envelope.
    CREATE TABLE IF NOT EXISTS agent_turns (
      turn_id TEXT PRIMARY KEY,
      machine_id TEXT NOT NULL,
      group_folder TEXT NOT NULL,
      group_jid TEXT,
      agent_profile TEXT,
      model TEXT NOT NULL,
      input_tokens INTEGER,
      output_tokens INTEGER,
      cache_creation_input_tokens INTEGER,
      cache_read_input_tokens INTEGER,
      est_cost_cents INTEGER,
      started_at TEXT NOT NULL,
      finished_at TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      duration_api_ms INTEGER,
      ttft_ms INTEGER,
      tool_use_count INTEGER DEFAULT 0,
      tool_error_count INTEGER DEFAULT 0,
      retry_count INTEGER DEFAULT 0,
      compaction_count INTEGER DEFAULT 0,
      num_turns INTEGER,
      exit_code INTEGER,
      outcome TEXT NOT NULL,
      error_class TEXT,
      prompt_chars INTEGER,
      response_chars INTEGER,
      session_id TEXT,
      is_main INTEGER DEFAULT 0,
      is_scheduled_task INTEGER DEFAULT 0,
      attachment_count INTEGER DEFAULT 0,
      truncated_output INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_agent_turns_started ON agent_turns(started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_agent_turns_group ON agent_turns(group_folder, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_agent_turns_machine ON agent_turns(machine_id, started_at DESC);
    -- Operator-action audit trail. Phase 0.5 (T-1778236000000).
    -- One row per state-changing API call (PATCH/POST /api/*).
    -- Per Q1 (Tailscale-trust), actor is constant 'operator' in v1 —
    -- multi-operator attribution arrives in v1.5 with auth.
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      machine_id TEXT NOT NULL,
      ts TEXT NOT NULL,
      actor TEXT NOT NULL DEFAULT 'operator',
      action TEXT NOT NULL,
      target TEXT,
      payload_before TEXT,
      payload_after TEXT,
      reversible_until TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_audit_log_ts ON audit_log(ts DESC);

    -- Agent registry. Gemini blueprint PR 1 (Phase H.1) — agents are the
    -- primary entity an operator manages; groups belong to agents. See
    -- docs/PROVIDER_PLAYBOOK.md § 0 (Taxonomy) and § 5.2 (Database schema).
    -- A single-agent deployment (the v1.0 default) has exactly one row
    -- here, synthesised on first orchestrator startup from the existing
    -- ASSISTANT_NAME / provider_default in setup-state.json.
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      persona TEXT,
      provider_protocol TEXT NOT NULL,
      provider_model TEXT NOT NULL,
      provider_base_url TEXT,
      credential_id TEXT,
      memory_namespace TEXT NOT NULL,
      default_trigger TEXT NOT NULL,
      parent_agent_id TEXT REFERENCES agents(id),
      is_default INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_agents_parent ON agents(parent_agent_id);
    CREATE INDEX IF NOT EXISTS idx_agents_default ON agents(is_default DESC);

    -- Channel pairings (multi-agent-completion blueprint § 4.1).
    -- Each row represents one external messaging connection — for
    -- WhatsApp, one Baileys auth state directory; for Telegram, one
    -- bot token; etc. Agents may share a pairing (the v1.0 default)
    -- or each carry their own (operator opt-in).
    --
    -- The deployment always has at least one row called
    -- 'whatsapp-shared' synthesised from the legacy store/auth/
    -- directory on v1.0 / v1.2 upgrade. Every chat and agent points
    -- at it by default, so the operator's existing behaviour is
    -- preserved byte-for-byte.
    CREATE TABLE IF NOT EXISTS channel_pairings (
      id              TEXT PRIMARY KEY,
      kind            TEXT NOT NULL,
      display_name    TEXT NOT NULL,
      auth_path       TEXT NOT NULL,
      is_shared       INTEGER NOT NULL DEFAULT 0,
      phone_hint      TEXT,
      last_connected_at TEXT,
      created_at      TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_channel_pairings_kind ON channel_pairings(kind);
    CREATE INDEX IF NOT EXISTS idx_channel_pairings_shared ON channel_pairings(is_shared DESC);
  `);

  // Add context_mode column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE scheduled_tasks ADD COLUMN context_mode TEXT DEFAULT 'isolated'`,
    );
  } catch {
    /* column already exists */
  }

  // Add script column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(`ALTER TABLE scheduled_tasks ADD COLUMN script TEXT`);
  } catch {
    /* column already exists */
  }

  // Add is_bot_message column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE messages ADD COLUMN is_bot_message INTEGER DEFAULT 0`,
    );
    // Backfill: mark existing bot messages that used the content prefix pattern
    database
      .prepare(`UPDATE messages SET is_bot_message = 1 WHERE content LIKE ?`)
      .run(`${ASSISTANT_NAME}:%`);
  } catch {
    /* column already exists */
  }

  // Add is_main column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE registered_groups ADD COLUMN is_main INTEGER DEFAULT 0`,
    );
    // Backfill: existing rows with folder = 'main' are the main group
    database.exec(
      `UPDATE registered_groups SET is_main = 1 WHERE folder = 'main'`,
    );
  } catch {
    /* column already exists */
  }

  // Add channel and is_group columns if they don't exist (migration for existing DBs)
  try {
    database.exec(`ALTER TABLE chats ADD COLUMN channel TEXT`);
    database.exec(`ALTER TABLE chats ADD COLUMN is_group INTEGER DEFAULT 0`);
    // Backfill from JID patterns
    database.exec(
      `UPDATE chats SET channel = 'whatsapp', is_group = 1 WHERE jid LIKE '%@g.us'`,
    );
    database.exec(
      `UPDATE chats SET channel = 'whatsapp', is_group = 0 WHERE jid LIKE '%@s.whatsapp.net'`,
    );
    database.exec(
      `UPDATE chats SET channel = 'discord', is_group = 1 WHERE jid LIKE 'dc:%'`,
    );
    database.exec(
      `UPDATE chats SET channel = 'telegram', is_group = 0 WHERE jid LIKE 'tg:%'`,
    );
  } catch {
    /* columns already exist */
  }

  // Gemini blueprint PR 1 — Phase H.1: agent_id FK migration on
  // registered_groups and sessions. Backfill existing rows to the default
  // agent so a v1/v2 → v3 upgrade is invisible to the operator.
  // See docs/PROVIDER_PLAYBOOK.md § 10 (Migration from Anthropic-only).

  // Add agent_id column to registered_groups
  try {
    database.exec(
      `ALTER TABLE registered_groups ADD COLUMN agent_id TEXT REFERENCES agents(id)`,
    );
  } catch {
    /* column already exists */
  }
  try {
    database.exec(
      `CREATE INDEX IF NOT EXISTS idx_registered_groups_agent ON registered_groups(agent_id)`,
    );
  } catch {
    /* index already exists */
  }

  // Add agent_id column to sessions
  try {
    database.exec(
      `ALTER TABLE sessions ADD COLUMN agent_id TEXT REFERENCES agents(id)`,
    );
  } catch {
    /* column already exists */
  }
  try {
    database.exec(
      `CREATE INDEX IF NOT EXISTS idx_sessions_agent ON sessions(agent_id)`,
    );
  } catch {
    /* index already exists */
  }

  // Multi-agent completion blueprint § 3.2 — responder attribution.
  // Records which agent actually answered a given turn. Differs from
  // the group's `agent_id` when a per-message @trigger overrode the
  // group's assigned agent (e.g. @Ben replying in Andy's group).
  // Nullable + backfilled to NULL: old turns fall through to the
  // group's agent via COALESCE in the cost-rollup queries.
  try {
    database.exec(
      `ALTER TABLE agent_turns ADD COLUMN responder_agent_id TEXT REFERENCES agents(id)`,
    );
  } catch {
    /* column already exists */
  }
  try {
    database.exec(
      `CREATE INDEX IF NOT EXISTS idx_agent_turns_responder ON agent_turns(responder_agent_id, started_at DESC)`,
    );
  } catch {
    /* index already exists */
  }

  // Multi-agent completion blueprint § 5.2 — concurrency telemetry.
  // queue_wait_ms: how long a turn sat in the per-group FIFO before
  // spawning. concurrent_at_spawn: how many containers were already
  // running when this one spawned. Both nullable — older rows
  // (pre-v1.2.1) have NULL; the *measurement* wiring in
  // group-queue.ts is a follow-up PR. The schema lands here so the
  // future PR is a small append-to-insert change rather than a
  // schema migration on top of a hot table.
  try {
    database.exec(
      `ALTER TABLE agent_turns ADD COLUMN queue_wait_ms INTEGER`,
    );
  } catch {
    /* column already exists */
  }
  try {
    database.exec(
      `ALTER TABLE agent_turns ADD COLUMN concurrent_at_spawn INTEGER`,
    );
  } catch {
    /* column already exists */
  }

  // Multi-agent completion blueprint § 5.3 — per-agent mount allowlist
  // override. JSON-shaped (mirrors MountAllowlist from src/types.ts).
  // NULL = inherit the deployment-wide allowlist (the v1.0/v1.2
  // default). When set, the orchestrator intersects with the
  // deployment allowlist before mounting — per-agent can narrow but
  // never broaden.
  try {
    database.exec(
      `ALTER TABLE agents ADD COLUMN mount_allowlist_override TEXT`,
    );
  } catch {
    /* column already exists */
  }

  // Multi-agent-completion-blueprint § 4.2 — per-agent daily budget cap.
  // Cents per day. NULL = unbounded (the v1.0 / v1.2 default). When
  // set, the orchestrator's pre-spawn gate denies turns once the
  // agent's spend for the day exceeds this value. Independent from
  // the group-level open-DM budget; both apply (either trips).
  try {
    database.exec(
      `ALTER TABLE agents ADD COLUMN daily_budget_cents INTEGER`,
    );
  } catch {
    /* column already exists */
  }

  // Per-agent spend rollup. Atomic INCR on each successful turn so a
  // burst of concurrent spawns can't double-count. Date keyed
  // YYYY-MM-DD (UTC) — same convention as open_spend_log.
  database.exec(`
    CREATE TABLE IF NOT EXISTS agent_spend_log (
      date       TEXT NOT NULL,
      agent_id   TEXT NOT NULL REFERENCES agents(id),
      cents      INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (date, agent_id)
    );
    CREATE INDEX IF NOT EXISTS idx_agent_spend_date ON agent_spend_log(date DESC);
  `);

  // Multi-agent completion blueprint § 4.1 — channel pairing FKs.
  // chats.pairing_id records which pairing the chat was first seen
  // on; outbound replies route to the channel whose pairing matches.
  // agents.channel_pairing_id records the agent's preferred pairing
  // for agent-initiated outbound (scheduled tasks, etc.) — the
  // common case is "agent uses whichever pairing its chat is on,"
  // but agent-initiated traffic needs a default.
  try {
    database.exec(
      `ALTER TABLE chats ADD COLUMN pairing_id TEXT REFERENCES channel_pairings(id)`,
    );
  } catch {
    /* column already exists */
  }
  try {
    database.exec(
      `CREATE INDEX IF NOT EXISTS idx_chats_pairing ON chats(pairing_id)`,
    );
  } catch {
    /* index already exists */
  }
  try {
    database.exec(
      `ALTER TABLE agents ADD COLUMN channel_pairing_id TEXT REFERENCES channel_pairings(id)`,
    );
  } catch {
    /* column already exists */
  }
  try {
    database.exec(
      `CREATE INDEX IF NOT EXISTS idx_agents_pairing ON agents(channel_pairing_id)`,
    );
  } catch {
    /* index already exists */
  }

  // Synthesise the shared WhatsApp pairing on first run. On v1.0 /
  // v1.2 installs, store/auth/creds.json already exists — we point
  // the synthesised pairing at the same directory. Operators
  // continue using the existing WhatsApp account with no
  // re-pairing needed. After the synthesis, every existing chat
  // gets its pairing_id backfilled to 'whatsapp-shared'; every
  // existing agent gets channel_pairing_id pointing there too.
  const existingPairingCount = (
    database
      .prepare(`SELECT COUNT(*) AS n FROM channel_pairings`)
      .get() as { n: number }
  ).n;
  if (existingPairingCount === 0) {
    const sharedPairingId = 'whatsapp-shared';
    const authPath = path.join(STORE_DIR, 'auth');
    database
      .prepare(
        `INSERT INTO channel_pairings
           (id, kind, display_name, auth_path, is_shared, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        sharedPairingId,
        'whatsapp',
        'Shared WhatsApp',
        authPath,
        1,
        new Date().toISOString(),
      );
    logger.info(
      { pairingId: sharedPairingId, authPath },
      'Synthesised whatsapp-shared pairing from existing store/auth',
    );
  }

  // Backfill any chats / agents that don't yet have a pairing_id.
  // Picks the deployment's first shared pairing (the synthesised
  // whatsapp-shared on v1.0 upgrades).
  const sharedPairingRow = database
    .prepare(
      `SELECT id FROM channel_pairings
        WHERE kind = 'whatsapp' AND is_shared = 1
        ORDER BY created_at ASC LIMIT 1`,
    )
    .get() as { id: string } | undefined;
  if (sharedPairingRow) {
    database
      .prepare(`UPDATE chats SET pairing_id = ? WHERE pairing_id IS NULL`)
      .run(sharedPairingRow.id);
    database
      .prepare(
        `UPDATE agents SET channel_pairing_id = ? WHERE channel_pairing_id IS NULL`,
      )
      .run(sharedPairingRow.id);
  }

  // Add kind column to sessions (PROVIDER_PLAYBOOK § 5.4 — session kinds).
  // Reserved values: 'group' (default), 'dashboard-cli' (future embedded
  // chat), 'sandboxed-test' (model-switch modal's throwaway tests),
  // 'agent-to-agent' (future agent swarms — see PROVIDER_PLAYBOOK § 11.3).
  try {
    database.exec(
      `ALTER TABLE sessions ADD COLUMN kind TEXT NOT NULL DEFAULT 'group'`,
    );
  } catch {
    /* column already exists */
  }

  // Synthesise the default agent on first run. The agent's name and
  // provider come from ASSISTANT_NAME and ANTHROPIC_MODEL (with the
  // existing claude-opus-4.6 fallback that the Claude container already
  // uses). The agent's id is the lowercased + slugified assistant name.
  // Operators on a v1/v2 install see no UX change — they keep their
  // assistant, they just now have a stable agent_id behind it that the
  // new dashboard can hang per-agent affordances off.
  const existingAgentCount = (
    database.prepare(`SELECT COUNT(*) AS n FROM agents`).get() as { n: number }
  ).n;
  if (existingAgentCount === 0) {
    const defaultAgent = synthesiseDefaultAgent();
    database
      .prepare(
        `INSERT INTO agents
           (id, name, persona, provider_protocol, provider_model,
            provider_base_url, credential_id, memory_namespace,
            default_trigger, parent_agent_id, is_default, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        defaultAgent.id,
        defaultAgent.name,
        defaultAgent.persona,
        defaultAgent.provider.protocol,
        defaultAgent.provider.model,
        defaultAgent.provider.base_url,
        defaultAgent.provider.credential_id,
        defaultAgent.memory_namespace,
        defaultAgent.default_trigger,
        defaultAgent.parent_agent_id,
        defaultAgent.is_default ? 1 : 0,
        defaultAgent.created_at,
      );
    logger.info(
      { agent: defaultAgent.id, provider: defaultAgent.provider.protocol },
      'Synthesised default agent from setup-state',
    );
  }

  // Backfill agent_id on any rows that don't have one yet (existing v1/v2
  // installs upgrading to v3). The first agent in the table is the
  // default; we just inserted it above when the table was empty.
  const defaultRow = database
    .prepare(`SELECT id FROM agents WHERE is_default = 1 LIMIT 1`)
    .get() as { id: string } | undefined;
  if (defaultRow) {
    database
      .prepare(
        `UPDATE registered_groups SET agent_id = ? WHERE agent_id IS NULL`,
      )
      .run(defaultRow.id);
    database
      .prepare(`UPDATE sessions SET agent_id = ? WHERE agent_id IS NULL`)
      .run(defaultRow.id);
  }
}

/**
 * Build the default agent record from existing single-assistant state.
 * Used on first run of the v3-aware schema to migrate v1/v2 installs
 * transparently. See PROVIDER_PLAYBOOK § 10.
 */
function synthesiseDefaultAgent(): {
  id: string;
  name: string;
  persona: string;
  provider: { protocol: string; model: string; base_url: string | null; credential_id: string | null };
  memory_namespace: string;
  default_trigger: string;
  parent_agent_id: string | null;
  is_default: boolean;
  created_at: string;
} {
  const name = ASSISTANT_NAME || 'Andy';
  // Slug rules match cli/claw-setup/src/state.ts assistant-name regex:
  // lowercase the display name, replace non-[a-z0-9-] with '-', collapse
  // runs of '-', trim leading/trailing '-'.
  const id =
    name
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '') || 'andy';
  // Provider defaults: the existing Claude install today routes through
  // claude-opus-4.6 unless ANTHROPIC_MODEL overrides it. Mirror that here
  // so the synthesised agent reflects the current operator's reality.
  const model = process.env.ANTHROPIC_MODEL || 'claude-opus-4.6';
  return {
    id,
    name,
    persona: '',
    provider: {
      protocol: 'anthropic',
      model,
      base_url: null,
      credential_id: 'Anthropic',
    },
    memory_namespace: `agents/${id}`,
    default_trigger: `@${name}`,
    parent_agent_id: null,
    is_default: true,
    created_at: new Date().toISOString(),
  };
}

export function initDatabase(): void {
  const dbPath = path.join(STORE_DIR, 'messages.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  db = new Database(dbPath);
  createSchema(db);

  // Migrate from JSON files if they exist
  migrateJsonState();
}

/** @internal - for tests only. Creates a fresh in-memory database. */
export function _initTestDatabase(): void {
  db = new Database(':memory:');
  createSchema(db);
}

/** @internal - for tests only. */
export function _closeDatabase(): void {
  db.close();
}

/**
 * @internal Used by sibling modules (e.g. `src/agents.ts`) that need direct
 * statement access without re-exporting every helper through db.ts. New
 * callers should prefer adding a named helper here; this getter exists so
 * domain-specific modules (agents, providers) can encapsulate their own
 * queries without polluting db.ts with per-domain logic.
 */
export function getDb(): Database.Database {
  return db;
}

/**
 * Store chat metadata only (no message content).
 * Used for all chats to enable group discovery without storing sensitive content.
 */
export function storeChatMetadata(
  chatJid: string,
  timestamp: string,
  name?: string,
  channel?: string,
  isGroup?: boolean,
): void {
  const ch = channel ?? null;
  const group = isGroup === undefined ? null : isGroup ? 1 : 0;

  if (name) {
    // Update with name, preserving existing timestamp if newer
    db.prepare(
      `
      INSERT INTO chats (jid, name, last_message_time, channel, is_group) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET
        name = excluded.name,
        last_message_time = MAX(last_message_time, excluded.last_message_time),
        channel = COALESCE(excluded.channel, channel),
        is_group = COALESCE(excluded.is_group, is_group)
    `,
    ).run(chatJid, name, timestamp, ch, group);
  } else {
    // Update timestamp only, preserve existing name if any
    db.prepare(
      `
      INSERT INTO chats (jid, name, last_message_time, channel, is_group) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET
        last_message_time = MAX(last_message_time, excluded.last_message_time),
        channel = COALESCE(excluded.channel, channel),
        is_group = COALESCE(excluded.is_group, is_group)
    `,
    ).run(chatJid, chatJid, timestamp, ch, group);
  }
}

/**
 * Update chat name without changing timestamp for existing chats.
 * New chats get the current time as their initial timestamp.
 * Used during group metadata sync.
 */
export function updateChatName(chatJid: string, name: string): void {
  db.prepare(
    `
    INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)
    ON CONFLICT(jid) DO UPDATE SET name = excluded.name
  `,
  ).run(chatJid, name, new Date().toISOString());
}

export interface ChatInfo {
  jid: string;
  name: string;
  last_message_time: string;
  channel: string;
  is_group: number;
}

/**
 * Get all known chats, ordered by most recent activity.
 */
export function getAllChats(): ChatInfo[] {
  return db
    .prepare(
      `
    SELECT jid, name, last_message_time, channel, is_group
    FROM chats
    ORDER BY last_message_time DESC
  `,
    )
    .all() as ChatInfo[];
}

/**
 * Get timestamp of last group metadata sync.
 */
export function getLastGroupSync(): string | null {
  // Store sync time in a special chat entry
  const row = db
    .prepare(`SELECT last_message_time FROM chats WHERE jid = '__group_sync__'`)
    .get() as { last_message_time: string } | undefined;
  return row?.last_message_time || null;
}

/**
 * Record that group metadata was synced.
 */
export function setLastGroupSync(): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT OR REPLACE INTO chats (jid, name, last_message_time) VALUES ('__group_sync__', '__group_sync__', ?)`,
  ).run(now);
}

/**
 * Store a message with full content.
 * Only call this for registered groups where message history is needed.
 */
export function storeMessage(msg: NewMessage): void {
  db.prepare(
    `INSERT OR REPLACE INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    msg.id,
    msg.chat_jid,
    msg.sender,
    msg.sender_name,
    msg.content,
    msg.timestamp,
    msg.is_from_me ? 1 : 0,
    msg.is_bot_message ? 1 : 0,
  );
}

/**
 * Store a message directly.
 */
export function storeMessageDirect(msg: {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me: boolean;
  is_bot_message?: boolean;
}): void {
  db.prepare(
    `INSERT OR REPLACE INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    msg.id,
    msg.chat_jid,
    msg.sender,
    msg.sender_name,
    msg.content,
    msg.timestamp,
    msg.is_from_me ? 1 : 0,
    msg.is_bot_message ? 1 : 0,
  );
}

export function getNewMessages(
  jids: string[],
  lastTimestamp: string,
  botPrefix: string,
  limit: number = 200,
): { messages: NewMessage[]; newTimestamp: string } {
  if (jids.length === 0) return { messages: [], newTimestamp: lastTimestamp };

  const placeholders = jids.map(() => '?').join(',');
  // Filter bot messages using both the is_bot_message flag AND the content
  // prefix as a backstop for messages written before the migration ran.
  // Subquery takes the N most recent, outer query re-sorts chronologically.
  const sql = `
    SELECT * FROM (
      SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me
      FROM messages
      WHERE timestamp > ? AND chat_jid IN (${placeholders})
        AND is_bot_message = 0 AND content NOT LIKE ?
        AND content != '' AND content IS NOT NULL
      ORDER BY timestamp DESC
      LIMIT ?
    ) ORDER BY timestamp
  `;

  const rows = db
    .prepare(sql)
    .all(lastTimestamp, ...jids, `${botPrefix}:%`, limit) as NewMessage[];

  let newTimestamp = lastTimestamp;
  for (const row of rows) {
    if (row.timestamp > newTimestamp) newTimestamp = row.timestamp;
  }

  return { messages: rows, newTimestamp };
}

export function getMessagesSince(
  chatJid: string,
  sinceTimestamp: string,
  botPrefix: string,
  limit: number = 200,
): NewMessage[] {
  // Filter bot messages using both the is_bot_message flag AND the content
  // prefix as a backstop for messages written before the migration ran.
  // Subquery takes the N most recent, outer query re-sorts chronologically.
  const sql = `
    SELECT * FROM (
      SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me
      FROM messages
      WHERE chat_jid = ? AND timestamp > ?
        AND is_bot_message = 0 AND content NOT LIKE ?
        AND content != '' AND content IS NOT NULL
      ORDER BY timestamp DESC
      LIMIT ?
    ) ORDER BY timestamp
  `;
  return db
    .prepare(sql)
    .all(chatJid, sinceTimestamp, `${botPrefix}:%`, limit) as NewMessage[];
}

export function getLastBotMessageTimestamp(
  chatJid: string,
  botPrefix: string,
): string | undefined {
  const row = db
    .prepare(
      `SELECT MAX(timestamp) as ts FROM messages
       WHERE chat_jid = ? AND (is_bot_message = 1 OR content LIKE ?)`,
    )
    .get(chatJid, `${botPrefix}:%`) as { ts: string | null } | undefined;
  return row?.ts ?? undefined;
}

export function createTask(
  task: Omit<ScheduledTask, 'last_run' | 'last_result'>,
): void {
  db.prepare(
    `
    INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, script, schedule_type, schedule_value, context_mode, next_run, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    task.id,
    task.group_folder,
    task.chat_jid,
    task.prompt,
    task.script || null,
    task.schedule_type,
    task.schedule_value,
    task.context_mode || 'isolated',
    task.next_run,
    task.status,
    task.created_at,
  );
}

export function getTaskById(id: string): ScheduledTask | undefined {
  return db.prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get(id) as
    | ScheduledTask
    | undefined;
}

export function getTasksForGroup(groupFolder: string): ScheduledTask[] {
  return db
    .prepare(
      'SELECT * FROM scheduled_tasks WHERE group_folder = ? ORDER BY created_at DESC',
    )
    .all(groupFolder) as ScheduledTask[];
}

export function getAllTasks(): ScheduledTask[] {
  return db
    .prepare('SELECT * FROM scheduled_tasks ORDER BY created_at DESC')
    .all() as ScheduledTask[];
}

export function updateTask(
  id: string,
  updates: Partial<
    Pick<
      ScheduledTask,
      | 'prompt'
      | 'script'
      | 'schedule_type'
      | 'schedule_value'
      | 'next_run'
      | 'status'
    >
  >,
): void {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.prompt !== undefined) {
    fields.push('prompt = ?');
    values.push(updates.prompt);
  }
  if (updates.script !== undefined) {
    fields.push('script = ?');
    values.push(updates.script || null);
  }
  if (updates.schedule_type !== undefined) {
    fields.push('schedule_type = ?');
    values.push(updates.schedule_type);
  }
  if (updates.schedule_value !== undefined) {
    fields.push('schedule_value = ?');
    values.push(updates.schedule_value);
  }
  if (updates.next_run !== undefined) {
    fields.push('next_run = ?');
    values.push(updates.next_run);
  }
  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
  }

  if (fields.length === 0) return;

  values.push(id);
  db.prepare(
    `UPDATE scheduled_tasks SET ${fields.join(', ')} WHERE id = ?`,
  ).run(...values);
}

export function deleteTask(id: string): void {
  // Delete child records first (FK constraint)
  db.prepare('DELETE FROM task_run_logs WHERE task_id = ?').run(id);
  db.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id);
}

export function getDueTasks(): ScheduledTask[] {
  const now = new Date().toISOString();
  return db
    .prepare(
      `
    SELECT * FROM scheduled_tasks
    WHERE status = 'active' AND next_run IS NOT NULL AND next_run <= ?
    ORDER BY next_run
  `,
    )
    .all(now) as ScheduledTask[];
}

export function updateTaskAfterRun(
  id: string,
  nextRun: string | null,
  lastResult: string,
): void {
  const now = new Date().toISOString();
  db.prepare(
    `
    UPDATE scheduled_tasks
    SET next_run = ?, last_run = ?, last_result = ?, status = CASE WHEN ? IS NULL THEN 'completed' ELSE status END
    WHERE id = ?
  `,
  ).run(nextRun, now, lastResult, nextRun, id);
}

export function logTaskRun(log: TaskRunLog): void {
  db.prepare(
    `
    INSERT INTO task_run_logs (task_id, run_at, duration_ms, status, result, error)
    VALUES (?, ?, ?, ?, ?, ?)
  `,
  ).run(
    log.task_id,
    log.run_at,
    log.duration_ms,
    log.status,
    log.result,
    log.error,
  );
}

// --- Router state accessors ---

export function getRouterState(key: string): string | undefined {
  const row = db
    .prepare('SELECT value FROM router_state WHERE key = ?')
    .get(key) as { value: string } | undefined;
  return row?.value;
}

export function setRouterState(key: string, value: string): void {
  db.prepare(
    'INSERT OR REPLACE INTO router_state (key, value) VALUES (?, ?)',
  ).run(key, value);
}

// --- Session accessors ---

export function getSession(groupFolder: string): string | undefined {
  const row = db
    .prepare('SELECT session_id FROM sessions WHERE group_folder = ?')
    .get(groupFolder) as { session_id: string } | undefined;
  return row?.session_id;
}

export function setSession(groupFolder: string, sessionId: string): void {
  db.prepare(
    'INSERT OR REPLACE INTO sessions (group_folder, session_id) VALUES (?, ?)',
  ).run(groupFolder, sessionId);
}

export function getAllSessions(): Record<string, string> {
  const rows = db
    .prepare('SELECT group_folder, session_id FROM sessions')
    .all() as Array<{ group_folder: string; session_id: string }>;
  const result: Record<string, string> = {};
  for (const row of rows) {
    result[row.group_folder] = row.session_id;
  }
  return result;
}

// --- Registered group accessors ---

export function getRegisteredGroup(
  jid: string,
): (RegisteredGroup & { jid: string }) | undefined {
  const row = db
    .prepare('SELECT * FROM registered_groups WHERE jid = ?')
    .get(jid) as
    | {
        jid: string;
        name: string;
        folder: string;
        trigger_pattern: string;
        added_at: string;
        container_config: string | null;
        requires_trigger: number | null;
        is_main: number | null;
        agent_id: string | null;
      }
    | undefined;
  if (!row) return undefined;
  if (!isValidGroupFolder(row.folder)) {
    logger.warn(
      { jid: row.jid, folder: row.folder },
      'Skipping registered group with invalid folder',
    );
    return undefined;
  }
  return {
    jid: row.jid,
    name: row.name,
    folder: row.folder,
    trigger: row.trigger_pattern,
    added_at: row.added_at,
    containerConfig: row.container_config
      ? JSON.parse(row.container_config)
      : undefined,
    requiresTrigger:
      row.requires_trigger === null ? undefined : row.requires_trigger === 1,
    isMain: row.is_main === 1 ? true : undefined,
    agent_id: row.agent_id ?? null,
  };
}

export function setRegisteredGroup(jid: string, group: RegisteredGroup): void {
  if (!isValidGroupFolder(group.folder)) {
    throw new Error(`Invalid group folder "${group.folder}" for JID ${jid}`);
  }
  db.prepare(
    `INSERT OR REPLACE INTO registered_groups (jid, name, folder, trigger_pattern, added_at, container_config, requires_trigger, is_main)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    jid,
    group.name,
    group.folder,
    group.trigger,
    group.added_at,
    group.containerConfig ? JSON.stringify(group.containerConfig) : null,
    group.requiresTrigger === undefined ? 1 : group.requiresTrigger ? 1 : 0,
    group.isMain ? 1 : 0,
  );
}

export function getAllRegisteredGroups(): Record<string, RegisteredGroup> {
  const rows = db.prepare('SELECT * FROM registered_groups').all() as Array<{
    jid: string;
    name: string;
    folder: string;
    trigger_pattern: string;
    added_at: string;
    container_config: string | null;
    requires_trigger: number | null;
    is_main: number | null;
    agent_id: string | null;
  }>;
  const result: Record<string, RegisteredGroup> = {};
  for (const row of rows) {
    if (!isValidGroupFolder(row.folder)) {
      logger.warn(
        { jid: row.jid, folder: row.folder },
        'Skipping registered group with invalid folder',
      );
      continue;
    }
    result[row.jid] = {
      name: row.name,
      folder: row.folder,
      trigger: row.trigger_pattern,
      added_at: row.added_at,
      containerConfig: row.container_config
        ? JSON.parse(row.container_config)
        : undefined,
      requiresTrigger:
        row.requires_trigger === null ? undefined : row.requires_trigger === 1,
      isMain: row.is_main === 1 ? true : undefined,
      agent_id: row.agent_id ?? null,
    };
  }
  return result;
}

// --- Open DM mode: rate-limit buckets and daily spend log ---

export interface OpenRateBucket {
  sender_jid: string;
  tokens: number;
  last_refill: string;
}

export function getOpenRateBucket(
  senderJid: string,
): OpenRateBucket | undefined {
  return db
    .prepare(
      'SELECT sender_jid, tokens, last_refill FROM open_rate_buckets WHERE sender_jid = ?',
    )
    .get(senderJid) as OpenRateBucket | undefined;
}

export function setOpenRateBucket(bucket: OpenRateBucket): void {
  db.prepare(
    `INSERT INTO open_rate_buckets (sender_jid, tokens, last_refill) VALUES (?, ?, ?)
     ON CONFLICT(sender_jid) DO UPDATE SET tokens = excluded.tokens, last_refill = excluded.last_refill`,
  ).run(bucket.sender_jid, bucket.tokens, bucket.last_refill);
}

export function getOpenSpendForDate(date: string): {
  container_count: number;
  est_cost_cents: number;
} {
  const row = db
    .prepare(
      'SELECT container_count, est_cost_cents FROM open_spend_log WHERE date = ?',
    )
    .get(date) as
    | { container_count: number; est_cost_cents: number }
    | undefined;
  return row ?? { container_count: 0, est_cost_cents: 0 };
}

export function recordOpenSpend(date: string, addCents: number): void {
  db.prepare(
    `INSERT INTO open_spend_log (date, container_count, est_cost_cents) VALUES (?, 1, ?)
     ON CONFLICT(date) DO UPDATE SET
       container_count = container_count + 1,
       est_cost_cents = est_cost_cents + excluded.est_cost_cents`,
  ).run(date, addCents);
}

// --- Per-agent spend (multi-agent-completion-blueprint § 4.2) ---

/**
 * Today's cumulative spend for an agent, in cents. Returns 0 when the
 * agent has no rows for today. Used by the pre-spawn budget gate.
 */
export function getAgentSpendForDate(
  date: string,
  agentId: string,
): number {
  const row = db
    .prepare(
      'SELECT cents FROM agent_spend_log WHERE date = ? AND agent_id = ?',
    )
    .get(date, agentId) as { cents: number } | undefined;
  return row?.cents ?? 0;
}

/**
 * Atomic increment of an agent's daily spend. Uses SQL `INCR`
 * semantics (UPDATE … SET cents = cents + ?) so concurrent turns
 * don't race. SQLite's WAL mode makes the row-level write
 * effectively atomic.
 */
export function incrementAgentSpend(
  date: string,
  agentId: string,
  addCents: number,
): void {
  db.prepare(
    `INSERT INTO agent_spend_log (date, agent_id, cents) VALUES (?, ?, ?)
     ON CONFLICT(date, agent_id) DO UPDATE SET cents = cents + excluded.cents`,
  ).run(date, agentId, addCents);
}

// --- Agent turns telemetry (T-1778234000000) ---

export interface AgentTurnRow {
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
   * Agent that actually answered this turn. Nullable for back-compat
   * with pre-v1.2.1 rows (which fall through the COALESCE in the
   * cost-rollup query). Differs from the group's `agent_id` when a
   * per-message @<trigger> override dispatched to a different agent.
   * See multi-agent-completion-blueprint § 3.2.
   */
  responder_agent_id?: string | null;
  /**
   * Concurrency telemetry — milliseconds the turn waited in the FIFO
   * queue before its container spawned. See
   * multi-agent-completion-blueprint § 5.2.
   */
  queue_wait_ms?: number | null;
  /**
   * Concurrency telemetry — how many containers were already running
   * when this turn spawned. Sampled at acquire time.
   */
  concurrent_at_spawn?: number | null;
}

export function insertAgentTurn(row: AgentTurnRow): void {
  db.prepare(
    `INSERT OR REPLACE INTO agent_turns (
      turn_id, machine_id, group_folder, group_jid, agent_profile, model,
      input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens,
      est_cost_cents, started_at, finished_at, duration_ms, duration_api_ms, ttft_ms,
      tool_use_count, tool_error_count, retry_count, compaction_count, num_turns,
      exit_code, outcome, error_class, prompt_chars, response_chars, session_id,
      is_main, is_scheduled_task, attachment_count, truncated_output,
      responder_agent_id, queue_wait_ms, concurrent_at_spawn
    ) VALUES (
      @turn_id, @machine_id, @group_folder, @group_jid, @agent_profile, @model,
      @input_tokens, @output_tokens, @cache_creation_input_tokens, @cache_read_input_tokens,
      @est_cost_cents, @started_at, @finished_at, @duration_ms, @duration_api_ms, @ttft_ms,
      @tool_use_count, @tool_error_count, @retry_count, @compaction_count, @num_turns,
      @exit_code, @outcome, @error_class, @prompt_chars, @response_chars, @session_id,
      @is_main, @is_scheduled_task, @attachment_count, @truncated_output,
      @responder_agent_id, @queue_wait_ms, @concurrent_at_spawn
    )`,
  ).run({
    ...row,
    group_jid: row.group_jid ?? null,
    agent_profile: row.agent_profile ?? null,
    input_tokens: row.input_tokens ?? null,
    output_tokens: row.output_tokens ?? null,
    cache_creation_input_tokens: row.cache_creation_input_tokens ?? null,
    cache_read_input_tokens: row.cache_read_input_tokens ?? null,
    est_cost_cents: row.est_cost_cents ?? null,
    duration_api_ms: row.duration_api_ms ?? null,
    ttft_ms: row.ttft_ms ?? null,
    tool_use_count: row.tool_use_count ?? 0,
    tool_error_count: row.tool_error_count ?? 0,
    retry_count: row.retry_count ?? 0,
    compaction_count: row.compaction_count ?? 0,
    num_turns: row.num_turns ?? null,
    exit_code: row.exit_code ?? null,
    error_class: row.error_class ?? null,
    prompt_chars: row.prompt_chars ?? null,
    response_chars: row.response_chars ?? null,
    session_id: row.session_id ?? null,
    is_main: row.is_main ?? 0,
    is_scheduled_task: row.is_scheduled_task ?? 0,
    attachment_count: row.attachment_count ?? 0,
    truncated_output: row.truncated_output ?? 0,
    responder_agent_id: row.responder_agent_id ?? null,
    queue_wait_ms: row.queue_wait_ms ?? null,
    concurrent_at_spawn: row.concurrent_at_spawn ?? null,
  });
}

// --- JSON migration ---

function migrateJsonState(): void {
  const migrateFile = (filename: string) => {
    const filePath = path.join(DATA_DIR, filename);
    if (!fs.existsSync(filePath)) return null;
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      fs.renameSync(filePath, `${filePath}.migrated`);
      return data;
    } catch {
      return null;
    }
  };

  // Migrate router_state.json
  const routerState = migrateFile('router_state.json') as {
    last_timestamp?: string;
    last_agent_timestamp?: Record<string, string>;
  } | null;
  if (routerState) {
    if (routerState.last_timestamp) {
      setRouterState('last_timestamp', routerState.last_timestamp);
    }
    if (routerState.last_agent_timestamp) {
      setRouterState(
        'last_agent_timestamp',
        JSON.stringify(routerState.last_agent_timestamp),
      );
    }
  }

  // Migrate sessions.json
  const sessions = migrateFile('sessions.json') as Record<
    string,
    string
  > | null;
  if (sessions) {
    for (const [folder, sessionId] of Object.entries(sessions)) {
      setSession(folder, sessionId);
    }
  }

  // Migrate registered_groups.json
  const groups = migrateFile('registered_groups.json') as Record<
    string,
    RegisteredGroup
  > | null;
  if (groups) {
    for (const [jid, group] of Object.entries(groups)) {
      try {
        setRegisteredGroup(jid, group);
      } catch (err) {
        logger.warn(
          { jid, folder: group.folder, err },
          'Skipping migrated registered group with invalid folder',
        );
      }
    }
  }
}
