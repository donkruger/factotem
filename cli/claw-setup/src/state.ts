import fs from 'fs';
import os from 'os';
import path from 'path';
import { z } from 'zod';

const STATE_PATH = path.join(os.homedir(), '.config', 'nanoclaw', 'setup-state.json');

// Assistant-name validation: alphanumeric, must start with a letter, 2-20 chars.
// Used for the trigger word (`@<name>`) + signature line (`<name> here…`).
// Default 'Andy' preserves backward-compat for state files written before W.1.
const AssistantNameSchema = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9]{1,19}$/, 'must be 2-20 chars, alphanumeric, starting with a letter')
  .default('Andy');

// --- Provider + Agent schemas (Gemini blueprint PR 1, Phase H.1) -----------
//
// See docs/PROVIDER_PLAYBOOK.md § 0 (Taxonomy) and § 5.1 (Setup-state).
// Mirrored in nanoclaw/src/types.ts and (in PR 1) in
// cli/claw-setup-gui/src/main/services/state-store.ts. Whenever you change
// one, change all three.

export const ProviderSchema = z.object({
  /** lowercase identifier, e.g. 'anthropic', 'gemini', 'ollama' */
  protocol: z.string(),
  /** model name, e.g. 'claude-opus-4.6' or 'gemini-2.5-pro' */
  model: z.string(),
  /** non-null for local providers (Ollama, vLLM); null for cloud */
  base_url: z.string().nullable(),
  /** OneCLI secret name; null for local providers with no auth */
  credential_id: z.string().nullable(),
});
export type Provider = z.infer<typeof ProviderSchema>;

export const AgentSchema = z.object({
  /** Stable slug; derived from name on creation. */
  id: z.string(),
  /** Human-friendly display name. */
  name: AssistantNameSchema,
  /** Free-text persona description (system-prompt fragment). May be empty. */
  persona: z.string().default(''),
  provider: ProviderSchema,
  /** Filesystem namespace under groups/, e.g. 'agents/andy'. */
  memory_namespace: z.string(),
  /** WhatsApp/Telegram trigger prefix, e.g. '@Andy'. */
  default_trigger: z.string(),
  /** Nullable FK; reserved for the organogram (PROVIDER_PLAYBOOK § 11.2). */
  parent_agent_id: z.string().nullable().default(null),
  /** Exactly one agent per deployment has is_default = true. */
  is_default: z.boolean().default(false),
  /** ISO-8601 timestamp. */
  created_at: z.string(),
});
export type Agent = z.infer<typeof AgentSchema>;

// --- State schema v3 -------------------------------------------------------
//
// v3 introduces the agents registry. Legacy v1/v2 fields (`assistantName`,
// `provider_default`) are preserved on write so older clients can still
// read the file; readers synthesise them from `agents[is_default]` when
// missing. See PROVIDER_PLAYBOOK § 10 (Migration from Anthropic-only).

const StateSchemaV1 = z.object({
  version: z.literal(1),
  profile: z.enum(['solo', 'collaborator-invite', 'hobbyist']),
  assistantName: AssistantNameSchema,
  completedSteps: z.array(z.string()),
  currentStep: z.string().nullable(),
  startedAt: z.string(),
  lastUpdated: z.string(),
  data: z.record(z.unknown()),
});

const StateSchemaV2 = StateSchemaV1.extend({
  version: z.literal(2),
  // v2 added provider_default before v3 introduced the full agents array.
  provider_default: ProviderSchema.optional(),
});

const StateSchemaV3 = z.object({
  version: z.literal(3),
  profile: z.enum(['solo', 'collaborator-invite', 'hobbyist']),
  // Legacy single-assistant field — written by readers for older clients.
  // Source of truth in v3 is `agents[is_default == true].name`.
  assistantName: AssistantNameSchema,
  completedSteps: z.array(z.string()),
  currentStep: z.string().nullable(),
  startedAt: z.string(),
  lastUpdated: z.string(),
  data: z.record(z.unknown()),
  agents: z.array(AgentSchema),
  default_agent_id: z.string(),
  // Synthesised mirror of `agents[default].provider`. Kept on disk so
  // older clients (v2 readers) still see a non-empty provider_default.
  provider_default: ProviderSchema.optional(),
});

export const StateSchema = StateSchemaV3;
export type State = z.infer<typeof StateSchema>;

const VersionedStateSchema = z.union([StateSchemaV1, StateSchemaV2, StateSchemaV3]);

function slugifyAgentId(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '') || 'agent'
  );
}

function defaultAnthropicProvider(): Provider {
  return {
    protocol: 'anthropic',
    model: 'claude-opus-4.6',
    base_url: null,
    credential_id: 'Anthropic',
  };
}

/**
 * Build an Agent record from a v1/v2 single-assistant install. The agent's
 * id is the slugified assistant name; the provider defaults to Anthropic
 * (the only choice that existed in v1/v2) unless the v2 file carried an
 * explicit `provider_default`.
 */
function synthesiseDefaultAgent(
  assistantName: string,
  providerDefault: Provider | undefined,
  startedAt: string,
): Agent {
  return {
    id: slugifyAgentId(assistantName),
    name: assistantName,
    persona: '',
    provider: providerDefault ?? defaultAnthropicProvider(),
    memory_namespace: `agents/${slugifyAgentId(assistantName)}`,
    default_trigger: `@${assistantName}`,
    parent_agent_id: null,
    is_default: true,
    created_at: startedAt,
  };
}

/**
 * Migrate a v1 or v2 setup-state into v3 by synthesising a single default
 * agent from the existing single-assistant fields. Lossless: every legacy
 * field is preserved on disk and the agent reflects the operator's
 * current setup byte-for-byte.
 *
 * See PROVIDER_PLAYBOOK § 10 (Migration from Anthropic-only).
 */
export function migrateToV3(input: unknown): State {
  const parsed = VersionedStateSchema.parse(input);
  if (parsed.version === 3) return parsed;

  const providerDefault =
    parsed.version === 2 ? parsed.provider_default : undefined;
  const agent = synthesiseDefaultAgent(
    parsed.assistantName,
    providerDefault,
    parsed.startedAt,
  );

  return {
    version: 3,
    profile: parsed.profile,
    assistantName: parsed.assistantName,
    completedSteps: parsed.completedSteps,
    currentStep: parsed.currentStep,
    startedAt: parsed.startedAt,
    lastUpdated: parsed.lastUpdated,
    data: parsed.data,
    agents: [agent],
    default_agent_id: agent.id,
    provider_default: agent.provider,
  };
}

export async function writeState(state: State): Promise<void> {
  const tmp = STATE_PATH + '.tmp';
  await fs.promises.mkdir(path.dirname(STATE_PATH), { recursive: true, mode: 0o700 });

  // Keep the legacy single-assistant fields synthesised from the default
  // agent so v1/v2 readers (older orchestrators on the same machine) still
  // work. Source of truth on v3 is `agents[is_default]`.
  const defaultAgent =
    state.agents.find((a) => a.is_default) ?? state.agents[0];
  const payload: State = {
    ...state,
    lastUpdated: new Date().toISOString(),
    assistantName: defaultAgent?.name ?? state.assistantName,
    provider_default: defaultAgent?.provider ?? state.provider_default,
  };
  await fs.promises.writeFile(tmp, JSON.stringify(payload, null, 2), { mode: 0o600 });
  await fs.promises.rename(tmp, STATE_PATH);
}

export async function readState(): Promise<State | null> {
  try {
    const raw = await fs.promises.readFile(STATE_PATH, 'utf8');
    return migrateToV3(JSON.parse(raw));
  } catch (err: any) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

export function newState(profile: State['profile']): State {
  const startedAt = new Date().toISOString();
  const agent = synthesiseDefaultAgent('Andy', undefined, startedAt);
  return {
    version: 3,
    profile,
    // Default seeded here so step 00 has a value to pre-fill into the prompt.
    // Step 00 overwrites it with whatever the operator types — at which
    // point both `assistantName` and `agents[0].name` are updated together.
    assistantName: 'Andy',
    completedSteps: [],
    currentStep: null,
    startedAt,
    lastUpdated: startedAt,
    data: {},
    agents: [agent],
    default_agent_id: agent.id,
    provider_default: agent.provider,
  };
}

/**
 * Replace the default agent's display name. Keeps the agent id stable
 * (renaming an agent in the wizard or dashboard doesn't change its id)
 * but updates the human-facing name and trigger string everywhere the
 * wizard reads them. Used by the profile step when the operator picks a
 * non-default assistant name.
 */
export function renameDefaultAgent(state: State, newName: string): State {
  const agents = state.agents.map((a) =>
    a.is_default
      ? { ...a, name: newName, default_trigger: `@${newName}` }
      : a,
  );
  return { ...state, agents, assistantName: newName };
}

export const STATE_FILE_PATH = STATE_PATH;
