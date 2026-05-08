#!/usr/bin/env node
import fs from 'fs';
import os from 'os';
import path from 'path';
import * as clack from '@clack/prompts';
import { createUI, getLogFilePath } from './ui.js';
import { newState, readState, writeState, STATE_FILE_PATH, type State } from './state.js';
import type { Step } from './types.js';
import { step as step00 } from './steps/00-profile-mode.js';
import { step as step01 } from './steps/01-check-prereqs.js';
import { step as step02 } from './steps/02-install-prerequisites.js';
import { step as step03 } from './steps/03-configure-onecli.js';
import { step as step04 } from './steps/04-mounts-allowlist.js';
import { step as step05 } from './steps/05-build-container.js';
import { step as step06 } from './steps/06-pair-whatsapp.js';
import { step as step07 } from './steps/07-register-main-group.js';
import { step as step08 } from './steps/08-configure-openmode.js';
import { step as step09 } from './steps/09-install-launchd.js';
import { step as step10 } from './steps/10-smoke-test.js';
import { step as step11 } from './steps/11-handoff.js';

const HELP_TEXT = `claw-setup — Cold-start setup wizard for NanoClaw deployments

Usage:
  claw-setup [options]

Options:
  --help                       Show this help and exit
  --resume                     Resume an interrupted setup from saved state
  --force                      Wipe existing creds.json and re-pair WhatsApp
  --profile=<name>             Skip the profile prompt. One of: solo, hobbyist, collaborator-invite
  --no-color                   Disable coloured output
  --dry-run                    Skip live-system mutations (best-effort)

State file: ~/.config/nanoclaw/setup-state.json
Log file:   ~/.config/nanoclaw/setup-<timestamp>.log
`;

interface ParsedArgs {
  help: boolean;
  resume: boolean;
  force: boolean;
  profile: 'solo' | 'hobbyist' | 'collaborator-invite' | null;
  noColor: boolean;
  dryRun: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = {
    help: false,
    resume: false,
    force: false,
    profile: null,
    noColor: false,
    dryRun: false,
  };
  for (const a of argv) {
    if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--resume') args.resume = true;
    else if (a === '--force') args.force = true;
    else if (a === '--no-color') args.noColor = true;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a.startsWith('--profile=')) {
      const v = a.slice('--profile='.length);
      if (v === 'solo' || v === 'hobbyist' || v === 'collaborator-invite') {
        args.profile = v;
      } else {
        process.stderr.write(`Unknown profile: ${v}\n`);
        process.exit(1);
      }
    }
  }
  return args;
}

function credsExist(): boolean {
  const credsPath = path.join(process.cwd(), 'store', 'auth', 'creds.json');
  return fs.existsSync(credsPath);
}

function inDocumentsRoot(): boolean {
  if (process.platform !== 'darwin') return false;
  const cwd = process.cwd();
  return /^\/Users\/[^/]+\/Documents\//.test(cwd);
}

// Step order — W.1 (2026-05-08) reordered the WhatsApp + bootstrap +
// open-DM steps so that 07 / 08 run AFTER the orchestrator is live.
//
// Old order:  06 → 07 → 08 → 09 → 10 → 11
// New order:  06 → 09 → 07 → 08 → 10 → 11
//
// Why: steps 07 (register main group) and 08 (open-DM config) need to
// query the orchestrator's chats DB and SIGHUP the live process. Both
// of those require the orchestrator to be running, so launchd bootstrap
// (step 09) has to come first. This eliminates the brittle two-process
// Baileys race that the old order used to do "pre-bootstrap" group
// sync in step 07.
//
// Step IDs are unchanged — only the run order moves. State files keep
// `completedSteps` as an unordered set so resume from any old state
// still works.
const STEPS: Step[] = [
  step00,
  step01,
  step02,
  step03,
  step04,
  step05,
  step06,
  step09,
  step07,
  step08,
  step10,
  step11,
];

async function runStep(step: Step, state: State, ui: ReturnType<typeof createUI>): Promise<State> {
  if (step.appliesTo && !step.appliesTo.includes(state.profile)) {
    return state;
  }

  ui.step(step.id, step.title);

  const checkResult = await step.check(state);
  if (checkResult.done) {
    ui.success(`already done${checkResult.reason ? ` — ${checkResult.reason}` : ''}`);
    if (!state.completedSteps.includes(step.id)) {
      state.completedSteps = [...state.completedSteps, step.id];
      await writeState(state);
    }
    return state;
  }

  state.currentStep = step.id;
  await writeState(state);

  if (step.prepare) {
    const prepData = await step.prepare(state, ui);
    state.data = { ...state.data, ...prepData };
    await writeState(state);
  }

  const result = await step.execute(state, ui);
  if (result.warning) {
    ui.warn(result.warning);
  }
  if (result.data) {
    state.data = { ...state.data, ...result.data };
  }

  const verifyResult = await step.verify(state);
  if (!verifyResult.ok) {
    ui.error(`verification failed: ${verifyResult.details ?? 'unknown reason'}`);
    throw new Error(`Step ${step.id} verification failed`);
  }

  ui.success(verifyResult.details ?? 'done');
  state.completedSteps = [...state.completedSteps, step.id];
  state.currentStep = null;
  await writeState(state);
  return state;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    process.stdout.write(HELP_TEXT);
    process.exit(0);
  }

  // Pre-step refuse: existing creds, no --force, not resuming
  if (credsExist() && !args.force && !args.resume) {
    process.stdout.write(
      'Existing creds.json detected at store/auth/creds.json.\n' +
        'Pass --force to wipe and re-pair (you will lose the WhatsApp session).\n' +
        'Or run with --resume to continue an interrupted setup.\n',
    );
    process.exit(1);
  }

  const ui = createUI({ noColor: args.noColor || !!process.env.NO_COLOR });

  ui.intro(
    'NanoClaw Setup Wizard',
    'Cold-start onboarding for new operators of the NanoClaw stack.',
  );
  ui.note('Logs', `Raw command output: ${getLogFilePath()}`);
  ui.note('State', `Resumable state file: ${STATE_FILE_PATH}`);

  // TCC hard-stop warning for Documents-rooted layouts
  if (inDocumentsRoot()) {
    ui.warn(
      'Wizard is running from a path under ~/Documents/. macOS TCC may silently kill writes by background services.',
    );
    const cont = await clack.confirm({
      message:
        'Continue anyway? (Recommended: abort and move NanoClaw out of ~/Documents/, e.g. to ~/NanoClaw/.)',
      initialValue: false,
    });
    if (!cont || clack.isCancel(cont)) {
      ui.error('Aborted by operator.');
      process.exit(1);
    }
  }

  // Load or initialise state
  let state: State;
  if (args.resume) {
    const existing = await readState();
    if (!existing) {
      ui.error(`No saved state found at ${STATE_FILE_PATH}. Cannot --resume.`);
      process.exit(1);
    }
    state = existing;
    ui.success(`resumed from ${existing.lastUpdated} (profile=${existing.profile})`);
  } else {
    // Profile resolution: flag wins, else step 00 prompts.
    const initialProfile = args.profile ?? 'solo';
    state = newState(initialProfile);
    state.data['__force_pair'] = args.force;
    state.data['__dry_run'] = args.dryRun;
    if (args.profile) {
      state.data['__profile_locked'] = true;
    }
    await writeState(state);
  }

  // Run pipeline
  try {
    for (const stp of STEPS) {
      if (state.completedSteps.includes(stp.id)) {
        continue;
      }
      state = await runStep(stp, state, ui);
      // Profile may have been set by step 00; if collaborator-invite triggered a clean exit,
      // the step itself called process.exit(0).
    }
  } catch (err: any) {
    ui.error(`Fatal: ${err?.message ?? String(err)}`);
    state.currentStep = state.currentStep ?? null;
    try {
      await writeState(state);
    } catch {
      // best-effort
    }
    ui.note(
      'Resume',
      `Run \`npm run claw-setup -- --resume\` (from the factotem repo root) to continue from step ${state.currentStep ?? '<unknown>'}.`,
    );
    process.exit(1);
  }
}

main().catch((err) => {
  process.stderr.write(`Unhandled error: ${err?.message ?? String(err)}\n`);
  process.exit(1);
});
