import fs from 'fs';
import path from 'path';
import * as clack from '@clack/prompts';
import type { Step } from '../types.js';

// Assistant name validation: 2-20 chars, alphanumeric, must start with a letter.
// Mirrors the schema in `state.ts` so the prompt rejects bad input before save.
const ASSISTANT_NAME_RE = /^[A-Za-z][A-Za-z0-9]{1,19}$/;

// Append (don't overwrite) ASSISTANT_NAME to the orchestrator's .env so
// `src/config.ts` picks it up at startup. Idempotent: if a value is
// already set we leave it alone — operators with existing 'Ben' / 'Andy'
// deployments shouldn't get silently rewritten by re-running the wizard.
//
// Returns one of:
//   - 'wrote'    — appended a new line
//   - 'exists'   — already present (any value)
//   - 'created'  — .env didn't exist, created with single line
function ensureAssistantNameInEnv(
  orchRoot: string,
  assistantName: string,
): 'wrote' | 'exists' | 'created' {
  const envPath = path.join(orchRoot, '.env');
  const line = `ASSISTANT_NAME=${assistantName}`;

  if (!fs.existsSync(envPath)) {
    fs.writeFileSync(envPath, line + '\n', { mode: 0o600 });
    return 'created';
  }

  const existing = fs.readFileSync(envPath, 'utf8');
  // Match `ASSISTANT_NAME=` at start of any line, ignoring leading whitespace
  // and `export ` prefixes commonly used in dotenv files.
  const hasExisting = /^[\t ]*(?:export[\t ]+)?ASSISTANT_NAME[\t ]*=/m.test(existing);
  if (hasExisting) {
    return 'exists';
  }

  // Append with a leading newline only if the file doesn't already end in one.
  const sep = existing.endsWith('\n') || existing.length === 0 ? '' : '\n';
  fs.appendFileSync(envPath, sep + line + '\n');
  return 'wrote';
}

export const step: Step = {
  id: '00-profile-mode',
  title: 'Choose deployment profile',

  async check(state) {
    if (state.data['__profile_locked'] === true) {
      return { done: true, reason: `profile locked from --profile flag (${state.profile})` };
    }
    if (state.completedSteps.includes('00-profile-mode')) {
      return { done: true, reason: `profile=${state.profile}, assistant=${state.assistantName}` };
    }
    return { done: false };
  },

  async execute(state, ui) {
    const choice = await clack.select({
      message: 'Which deployment profile fits your situation?',
      options: [
        {
          value: 'solo',
          label: 'solo',
          hint: 'Single operator on one machine — the standard NanoClaw layout',
        },
        {
          value: 'hobbyist',
          label: 'hobbyist',
          hint: 'Local-only experiment — no public exposure, no real WhatsApp',
        },
        {
          value: 'collaborator-invite',
          label: 'collaborator-invite',
          hint: 'Joining someone else\'s deployment as a collaborator',
        },
      ],
      initialValue: state.profile,
    });

    if (clack.isCancel(choice)) {
      ui.error('Profile selection cancelled.');
      process.exit(1);
    }

    const profile = choice as 'solo' | 'hobbyist' | 'collaborator-invite';

    if (profile === 'collaborator-invite') {
      ui.note(
        'Collaborator path',
        'This wizard sets up new deployments. To join an existing deployment as a collaborator, ask the operator for their dashboard URL and visit `/onboarding/accept-invite`. Exiting.',
      );
      ui.outro('No new deployment created.');
      process.exit(0);
    }

    state.profile = profile;

    // Persona prompt — controls the orchestrator's ASSISTANT_NAME (and
    // therefore DEFAULT_TRIGGER = `@<name>`). Persisted to state +
    // appended to .env at the end of the wizard. Also used as the
    // `--trigger` value when registering the main group in step 07.
    //
    // hobbyist profile still gets the prompt because the agent's
    // signature line (`<name> here…`) is the same in local-echo mode.
    const nameInput = await clack.text({
      message: 'What name should your assistant respond to?',
      placeholder: 'Andy',
      initialValue: state.assistantName ?? 'Andy',
      validate: (v) => {
        const trimmed = (v ?? '').trim();
        if (!trimmed) return 'Name is required.';
        if (!ASSISTANT_NAME_RE.test(trimmed)) {
          return 'Use 2-20 chars, alphanumeric, starting with a letter (e.g. Sarah, Ben, Andy).';
        }
        return undefined;
      },
    });
    if (clack.isCancel(nameInput)) {
      ui.error('Assistant-name selection cancelled.');
      process.exit(1);
    }
    const assistantName = (nameInput as string).trim();
    state.assistantName = assistantName;

    // Persist immediately to .env so step 09 (launchd bootstrap) and
    // every subsequent orchestrator invocation reads the right name.
    // The wizard runs from the orchestrator's CWD per claw-setup's
    // package.json convention.
    let envOutcome: 'wrote' | 'exists' | 'created' = 'wrote';
    try {
      envOutcome = ensureAssistantNameInEnv(process.cwd(), assistantName);
    } catch (err) {
      ui.warn(
        `Failed to write ASSISTANT_NAME to .env: ${(err as Error).message}. ` +
          'Add `ASSISTANT_NAME=' +
          assistantName +
          '` to .env manually before bootstrapping the orchestrator.',
      );
    }

    if (envOutcome === 'exists') {
      ui.warn(
        'ASSISTANT_NAME already set in .env — leaving existing value untouched.\n' +
          `Wizard state will use "${assistantName}" for the trigger word, but the\n` +
          'orchestrator will use whatever .env says. Edit .env manually if you want\n' +
          'them aligned.',
      );
    } else {
      ui.note(
        'Assistant identity',
        `Persona: ${assistantName}\n` +
          `Trigger: @${assistantName} (group messages addressed with this trigger reach the agent)\n` +
          `Wrote ASSISTANT_NAME=${assistantName} to .env (${envOutcome}).`,
      );
    }

    return { data: {} };
  },

  async verify(state) {
    if (!ASSISTANT_NAME_RE.test(state.assistantName)) {
      return { ok: false, details: `invalid assistantName=${state.assistantName}` };
    }
    if (state.profile === 'solo' || state.profile === 'hobbyist') {
      return { ok: true, details: `profile=${state.profile}, assistant=${state.assistantName}` };
    }
    return { ok: false, details: `unexpected profile=${state.profile}` };
  },
};
