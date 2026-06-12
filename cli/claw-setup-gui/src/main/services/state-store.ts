// State store — single source of truth at ~/.config/nanoclaw/setup-state.json.
//
// Shape and behaviour mirror `cli/claw-setup/src/state.ts` exactly so the
// CLI wizard (`claw-setup`) and this GUI wizard can coexist and resume
// each other's progress. If you change the schema here, change it in
// claw-setup/src/state.ts AND nanoclaw/src/types.ts at the same time and
// bump `version`. See docs/PROVIDER_PLAYBOOK.md § 5.1.

import fs from 'fs'
import os from 'os'
import path from 'path'
import { z } from 'zod'
import type { Agent, Provider, SetupState } from '../../shared/types'

export const STATE_PATH = path.join(
  os.homedir(),
  '.config',
  'nanoclaw',
  'setup-state.json'
)

// Mirrors claw-setup/src/state.ts — keep the regex identical.
const AssistantNameSchema = z
  .string()
  .regex(
    /^[A-Za-z][A-Za-z0-9]{1,19}$/,
    'must be 2-20 chars, alphanumeric, starting with a letter'
  )
  .default('Andy')

const ProviderSchema = z.object({
  protocol: z.string(),
  model: z.string(),
  base_url: z.string().nullable(),
  credential_id: z.string().nullable()
})

const AgentSchema = z.object({
  id: z.string(),
  name: AssistantNameSchema,
  persona: z.string().default(''),
  provider: ProviderSchema,
  memory_namespace: z.string(),
  default_trigger: z.string(),
  parent_agent_id: z.string().nullable().default(null),
  is_default: z.boolean().default(false),
  created_at: z.string()
})

// Three versions in the union — the GUI accepts v1 + v2 files written by
// older orchestrators on this machine and migrates them transparently to
// v3 on read, same as the CLI.

const StateSchemaV1 = z.object({
  version: z.literal(1),
  profile: z.enum(['solo', 'collaborator-invite', 'hobbyist']),
  assistantName: AssistantNameSchema,
  completedSteps: z.array(z.string()),
  currentStep: z.string().nullable(),
  startedAt: z.string(),
  lastUpdated: z.string(),
  data: z.record(z.unknown())
})

const StateSchemaV2 = StateSchemaV1.extend({
  version: z.literal(2),
  provider_default: ProviderSchema.optional()
})

const StateSchemaV3 = z.object({
  version: z.literal(3),
  profile: z.enum(['solo', 'collaborator-invite', 'hobbyist']),
  assistantName: AssistantNameSchema,
  completedSteps: z.array(z.string()),
  currentStep: z.string().nullable(),
  startedAt: z.string(),
  lastUpdated: z.string(),
  data: z.record(z.unknown()),
  agents: z.array(AgentSchema),
  default_agent_id: z.string(),
  provider_default: ProviderSchema.optional()
})

export const StateSchema = StateSchemaV3
const VersionedStateSchema = z.union([
  StateSchemaV1,
  StateSchemaV2,
  StateSchemaV3
])

function slugifyAgentId(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '') || 'agent'
  )
}

function defaultAnthropicProvider(): Provider {
  return {
    protocol: 'anthropic',
    model: 'claude-opus-4-6',
    base_url: null,
    credential_id: 'Anthropic'
  }
}

function synthesiseDefaultAgent(
  assistantName: string,
  providerDefault: Provider | undefined,
  startedAt: string
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
    created_at: startedAt
  }
}

function migrateToV3(input: unknown): SetupState {
  const parsed = VersionedStateSchema.parse(input)
  if (parsed.version === 3) return parsed as SetupState
  const providerDefault =
    parsed.version === 2 ? parsed.provider_default : undefined
  const agent = synthesiseDefaultAgent(
    parsed.assistantName,
    providerDefault,
    parsed.startedAt
  )
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
    provider_default: agent.provider
  }
}

export async function readState(): Promise<SetupState | null> {
  try {
    const raw = await fs.promises.readFile(STATE_PATH, 'utf8')
    return migrateToV3(JSON.parse(raw))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

export async function writeState(state: SetupState): Promise<void> {
  const tmp = STATE_PATH + '.tmp'
  await fs.promises.mkdir(path.dirname(STATE_PATH), {
    recursive: true,
    mode: 0o700
  })
  // Keep legacy single-assistant fields synthesised from the default agent
  // so v1/v2 readers (older orchestrator on this machine) still work.
  const defaultAgent =
    state.agents.find((a) => a.is_default) ?? state.agents[0]
  const payload: SetupState = {
    ...state,
    lastUpdated: new Date().toISOString(),
    assistantName: defaultAgent?.name ?? state.assistantName,
    provider_default: defaultAgent?.provider ?? state.provider_default
  }
  await fs.promises.writeFile(tmp, JSON.stringify(payload, null, 2), {
    mode: 0o600
  })
  await fs.promises.rename(tmp, STATE_PATH)
}

export function newState(profile: SetupState['profile']): SetupState {
  const startedAt = new Date().toISOString()
  const agent = synthesiseDefaultAgent('Andy', undefined, startedAt)
  return {
    version: 3,
    profile,
    assistantName: 'Andy',
    completedSteps: [],
    currentStep: null,
    startedAt,
    lastUpdated: startedAt,
    data: {},
    agents: [agent],
    default_agent_id: agent.id,
    provider_default: agent.provider
  }
}

export function renameDefaultAgent(
  state: SetupState,
  newName: string
): SetupState {
  const agents = state.agents.map((a) =>
    a.is_default
      ? { ...a, name: newName, default_trigger: `@${newName}` }
      : a
  )
  return { ...state, agents, assistantName: newName }
}
