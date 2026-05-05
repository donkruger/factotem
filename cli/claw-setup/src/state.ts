import fs from 'fs';
import os from 'os';
import path from 'path';
import { z } from 'zod';

const STATE_PATH = path.join(os.homedir(), '.config', 'nanoclaw', 'setup-state.json');

export const StateSchema = z.object({
  version: z.literal(1),
  profile: z.enum(['solo', 'collaborator-invite', 'hobbyist']),
  completedSteps: z.array(z.string()),
  currentStep: z.string().nullable(),
  startedAt: z.string(),
  lastUpdated: z.string(),
  data: z.record(z.unknown()),
});
export type State = z.infer<typeof StateSchema>;

export async function writeState(state: State): Promise<void> {
  const tmp = STATE_PATH + '.tmp';
  await fs.promises.mkdir(path.dirname(STATE_PATH), { recursive: true, mode: 0o700 });
  const payload = { ...state, lastUpdated: new Date().toISOString() };
  await fs.promises.writeFile(tmp, JSON.stringify(payload, null, 2), { mode: 0o600 });
  await fs.promises.rename(tmp, STATE_PATH);
}

export async function readState(): Promise<State | null> {
  try {
    const raw = await fs.promises.readFile(STATE_PATH, 'utf8');
    return StateSchema.parse(JSON.parse(raw));
  } catch (err: any) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

export function newState(profile: State['profile']): State {
  return {
    version: 1,
    profile,
    completedSteps: [],
    currentStep: null,
    startedAt: new Date().toISOString(),
    lastUpdated: new Date().toISOString(),
    data: {},
  };
}

export const STATE_FILE_PATH = STATE_PATH;
