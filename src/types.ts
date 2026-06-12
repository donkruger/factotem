export interface AdditionalMount {
  hostPath: string; // Absolute path on host (supports ~ for home)
  containerPath?: string; // Optional — defaults to basename of hostPath. Mounted at /workspace/extra/{value}
  readonly?: boolean; // Default: true for safety
}

/**
 * Mount Allowlist - Security configuration for additional mounts
 * This file should be stored at ~/.config/nanoclaw/mount-allowlist.json
 * and is NOT mounted into any container, making it tamper-proof from agents.
 */
export interface MountAllowlist {
  // Directories that can be mounted into containers
  allowedRoots: AllowedRoot[];
  // Glob patterns for paths that should never be mounted (e.g., ".ssh", ".gnupg")
  blockedPatterns: string[];
  // If true, non-main groups can only mount read-only regardless of config
  nonMainReadOnly: boolean;
}

export interface AllowedRoot {
  // Absolute path or ~ for home (e.g., "~/projects", "/var/repos")
  path: string;
  // Whether read-write mounts are allowed under this root
  allowReadWrite: boolean;
  // Optional description for documentation
  description?: string;
}

export interface OpenModeRateLimit {
  tokensPerHour: number;
  burstMax: number;
}

export interface OpenModeConfig {
  enabled: boolean;
  agentProfile?: 'open_dm';
  rateLimit?: OpenModeRateLimit;
  // Daily host-side cost cap. When exceeded, further open_dm message routing is dropped silently.
  // Required when enabled is true; null/undefined makes auto-registration fail closed.
  dailyBudgetCents?: number | null;
  // Per-invocation cost estimate in cents. Used to accumulate against dailyBudgetCents.
  estCostCentsPerInvocation?: number;
}

export interface ContainerConfig {
  additionalMounts?: AdditionalMount[];
  timeout?: number; // Default: 300000 (5 minutes)
  // 'main' = elevated, full tools; 'standard' = current default for non-main groups;
  // 'open_dm' = narrowed tool/permission/mount profile for unsolicited DM senders.
  agentProfile?: 'main' | 'standard' | 'open_dm';
  // Lives on a host group (typically main). When enabled, unregistered DM JIDs
  // hitting the channel can be auto-registered as 'open_dm' groups.
  openMode?: OpenModeConfig;
  // Per-group model override. Resolution order in the agent-runner:
  // containerConfig.model → process.env.ANTHROPIC_MODEL → 'claude-sonnet-4-6'.
  // Phase 0 of T-1777809840000 — will migrate into a profile.model field
  // once the configuration convention spike lands.
  model?: string;
  // Per-group provider override (PROVIDER_PLAYBOOK § 5.3 — rare path).
  // When set, wins over the agent's provider for this group only. Most
  // operators leave this absent and let groups inherit their agent's
  // provider. Surfaced in the dashboard under Advanced settings.
  provider?: Provider;
}

// --- Agents & providers (Gemini blueprint PR 1 — Phase H.1 + H.2) ---

/**
 * Wire-protocol identifier. Maps to a container image:
 *   'anthropic'         → nanoclaw-agent (the legacy/default Claude image)
 *   'openai-compatible' → nanoclaw-agent-oai (the OpenAI-shaped image used by
 *                         Gemini, OpenAI, OpenRouter, Together, Groq, Ollama,
 *                         vLLM, etc.)
 *
 * Per PROVIDER_PLAYBOOK § 1, this is "container per wire protocol" — the
 * provider's protocol identifier still distinguishes them (anthropic vs
 * gemini vs openai vs ollama) but they share the wire-protocol image when
 * they share a wire shape.
 */
export type WireProtocol = 'anthropic' | 'openai-compatible';

/**
 * Provider protocol identifier — lowercase, no punctuation. Examples:
 *   'anthropic', 'openai', 'gemini', 'ollama', 'openrouter', 'groq'
 *
 * The full `<protocol>/<model>` string (e.g. `gemini/gemini-2.5-pro`) is the
 * canonical model reference. See PROVIDER_PLAYBOOK § 12.
 */
export type ProviderProtocol = string;

export interface Provider {
  /** lowercase identifier, e.g. 'anthropic', 'gemini', 'ollama' */
  protocol: ProviderProtocol;
  /** model name, e.g. 'claude-opus-4-6' or 'gemini-2.5-pro' */
  model: string;
  /** non-null for local providers (Ollama, vLLM); null for cloud providers */
  base_url: string | null;
  /** OneCLI secret name; null for local providers with no auth */
  credential_id: string | null;
}

/**
 * An Agent is a named entity that owns a persona, a provider, and a memory
 * namespace. Groups belong to agents; the same machine can run multiple
 * agents (Andy on Claude, Ben on Gemini, Echo on Ollama). See
 * PROVIDER_PLAYBOOK § 0 for the canonical taxonomy.
 */
export interface Agent {
  /** Stable slug; derived from name on creation. Examples: 'andy', 'ben'. */
  id: string;
  /** Human-friendly display name. Operators rename via the dashboard. */
  name: string;
  /** Free-text persona description (system-prompt fragment). May be empty. */
  persona: string;
  /** The wire/model the agent talks to. */
  provider: Provider;
  /** Filesystem namespace under groups/, e.g. 'agents/andy'. */
  memory_namespace: string;
  /** WhatsApp/Telegram trigger prefix, e.g. '@Andy'. */
  default_trigger: string;
  /** Nullable FK; reserved for the organogram (PROVIDER_PLAYBOOK § 11.2). */
  parent_agent_id: string | null;
  /** Exactly one agent per deployment has is_default = true. */
  is_default: boolean;
  /** ISO-8601 timestamp. */
  created_at: string;
  /**
   * Per-agent mount allowlist override (multi-agent-completion § 5.3).
   * NULL = inherit deployment allowlist. When set, intersected with
   * the deployment allowlist before mounting — narrowing-only.
   */
  mount_allowlist_override?: MountAllowlist | null;
  /**
   * Channel pairing this agent uses by default (multi-agent-completion
   * § 4.1). When NULL, the agent uses the deployment's shared pairing.
   * Set via the wizard's H.5 add-agent flow or the dashboard's
   * agent-detail Settings.
   */
  channel_pairing_id?: string | null;
  /**
   * Per-agent daily budget cap in cents (multi-agent-completion § 4.2).
   * NULL = unbounded. When set, the orchestrator's pre-spawn gate
   * denies turns once the agent's daily spend exceeds this value.
   * Independent of the group-level open-DM budget; both layers apply.
   */
  daily_budget_cents?: number | null;
}

export interface RegisteredGroup {
  name: string;
  folder: string;
  trigger: string;
  added_at: string;
  containerConfig?: ContainerConfig;
  requiresTrigger?: boolean; // Default: true for groups, false for solo chats
  isMain?: boolean; // True for the main control group (no trigger, elevated privileges)
  // Foreign key into agents(id). Nullable for backward compatibility —
  // groups without an assignment fall through to the deployment's
  // default agent. Backfilled to the default agent on schema migration.
  // See docs/PROVIDER_PLAYBOOK.md § 0 (Taxonomy) and § 5.2.
  agent_id?: string | null;
}

export interface NewMessage {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me?: boolean;
  is_bot_message?: boolean;
}

export interface ScheduledTask {
  id: string;
  group_folder: string;
  chat_jid: string;
  prompt: string;
  script?: string | null;
  schedule_type: 'cron' | 'interval' | 'once';
  schedule_value: string;
  context_mode: 'group' | 'isolated';
  next_run: string | null;
  last_run: string | null;
  last_result: string | null;
  status: 'active' | 'paused' | 'completed';
  created_at: string;
}

export interface TaskRunLog {
  task_id: string;
  run_at: string;
  duration_ms: number;
  status: 'success' | 'error';
  result: string | null;
  error: string | null;
}

// --- Channel abstraction ---

export interface MessageMetadata {
  model?: string;
}

export interface Channel {
  name: string;
  connect(): Promise<void>;
  sendMessage(
    jid: string,
    text: string,
    metadata?: MessageMetadata,
  ): Promise<void>;
  isConnected(): boolean;
  ownsJid(jid: string): boolean;
  disconnect(): Promise<void>;
  // Optional: typing indicator. Channels that support it implement it.
  setTyping?(jid: string, isTyping: boolean): Promise<void>;
  // Optional: sync group/chat names from the platform.
  syncGroups?(force: boolean): Promise<void>;
}

// Callback type that channels use to deliver inbound messages
export type OnInboundMessage = (chatJid: string, message: NewMessage) => void;

// Callback for chat metadata discovery.
// name is optional — channels that deliver names inline (Telegram) pass it here;
// channels that sync names separately (via syncGroups) omit it.
export type OnChatMetadata = (
  chatJid: string,
  timestamp: string,
  name?: string,
  channel?: string,
  isGroup?: boolean,
) => void;
