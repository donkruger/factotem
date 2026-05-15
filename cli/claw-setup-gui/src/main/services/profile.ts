// Profile + assistant-name persistence.
//
// Mirrors the side effects of `cli/claw-setup/src/steps/00-profile-mode.ts`:
//   1. Writes profile + assistantName to ~/.config/nanoclaw/setup-state.json
//   2. Appends ASSISTANT_NAME=<name> to the orchestrator's .env (idempotent)
//
// The CLI step uses clack for input collection; the GUI collects the same
// values via a React form and POSTs them here. That's the pattern future
// "interactive" steps will follow — render the form in the renderer,
// hand the answers to a headless main-process handler.

import fs from 'fs'
import path from 'path'
import {
  newState,
  readState,
  renameDefaultAgent,
  STATE_PATH,
  writeState
} from './state-store'
import type {
  ProfileWriteInput,
  ProfileWriteResult,
  SetupState
} from '../../shared/types'

const ASSISTANT_NAME_RE = /^[A-Za-z][A-Za-z0-9]{1,19}$/

function ensureAssistantNameInEnv(
  orchRoot: string,
  assistantName: string
): 'wrote' | 'exists' | 'created' {
  const envPath = path.join(orchRoot, '.env')
  const line = `ASSISTANT_NAME=${assistantName}`

  if (!fs.existsSync(envPath)) {
    fs.writeFileSync(envPath, line + '\n', { mode: 0o600 })
    return 'created'
  }

  const existing = fs.readFileSync(envPath, 'utf8')
  const hasExisting =
    /^[\t ]*(?:export[\t ]+)?ASSISTANT_NAME[\t ]*=/m.test(existing)
  if (hasExisting) return 'exists'

  const sep = existing.endsWith('\n') || existing.length === 0 ? '' : '\n'
  fs.appendFileSync(envPath, sep + line + '\n')
  return 'wrote'
}

export async function writeProfile(
  input: ProfileWriteInput
): Promise<ProfileWriteResult> {
  if (!ASSISTANT_NAME_RE.test(input.assistantName)) {
    return {
      success: false,
      error: 'Assistant name must be 2-20 chars, alphanumeric, starting with a letter.',
      statePath: STATE_PATH
    }
  }

  // Load existing state if present (resume support), else seed fresh.
  let state: SetupState = (await readState()) ?? newState(input.profile)
  state.profile = input.profile
  // Keep the default agent's display name in sync with assistantName so
  // both the legacy field and agents[0].name reflect the operator's input.
  // See PROVIDER_PLAYBOOK § 5.1 — assistantName is the legacy mirror;
  // source of truth is agents[is_default].name.
  state = renameDefaultAgent(state, input.assistantName)
  if (!state.completedSteps.includes('00-profile-mode')) {
    state.completedSteps = [...state.completedSteps, '00-profile-mode']
  }
  state.currentStep = null

  try {
    await writeState(state)
  } catch (err) {
    return {
      success: false,
      error: `Failed to write state file: ${(err as Error).message}`,
      statePath: STATE_PATH
    }
  }

  // .env write is best-effort. If the orchestrator root isn't known, skip
  // and let the operator do it manually; we still consider the step a
  // success because state was persisted.
  let envOutcome: ProfileWriteResult['envOutcome'] = 'skipped'
  if (input.orchestratorRoot) {
    try {
      envOutcome = ensureAssistantNameInEnv(
        input.orchestratorRoot,
        input.assistantName
      )
    } catch (err) {
      return {
        success: true, // state saved; .env failure is recoverable
        envOutcome: 'skipped',
        error: `State saved, but failed to write .env: ${(err as Error).message}`,
        statePath: STATE_PATH
      }
    }
  }

  return {
    success: true,
    envOutcome,
    statePath: STATE_PATH
  }
}
