// State store — single source of truth at ~/.config/nanoclaw/setup-state.json.
//
// Shape and behaviour mirror `cli/claw-setup/src/state.ts` exactly so the
// CLI wizard (`claw-setup`) and this GUI wizard can coexist and resume
// each other's progress. If you change the schema here, change it in
// claw-setup/src/state.ts at the same time and bump `version`.

import fs from 'fs'
import os from 'os'
import path from 'path'
import { z } from 'zod'
import type { SetupState } from '../../shared/types'

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

export const StateSchema = z.object({
  version: z.literal(1),
  profile: z.enum(['solo', 'collaborator-invite', 'hobbyist']),
  assistantName: AssistantNameSchema,
  completedSteps: z.array(z.string()),
  currentStep: z.string().nullable(),
  startedAt: z.string(),
  lastUpdated: z.string(),
  data: z.record(z.unknown())
})

export async function readState(): Promise<SetupState | null> {
  try {
    const raw = await fs.promises.readFile(STATE_PATH, 'utf8')
    return StateSchema.parse(JSON.parse(raw)) as SetupState
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
  const payload: SetupState = { ...state, lastUpdated: new Date().toISOString() }
  await fs.promises.writeFile(tmp, JSON.stringify(payload, null, 2), {
    mode: 0o600
  })
  await fs.promises.rename(tmp, STATE_PATH)
}

export function newState(profile: SetupState['profile']): SetupState {
  return {
    version: 1,
    profile,
    assistantName: 'Andy',
    completedSteps: [],
    currentStep: null,
    startedAt: new Date().toISOString(),
    lastUpdated: new Date().toISOString(),
    data: {}
  }
}
