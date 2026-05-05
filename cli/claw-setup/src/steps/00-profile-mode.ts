import * as clack from '@clack/prompts';
import type { Step } from '../types.js';

export const step: Step = {
  id: '00-profile-mode',
  title: 'Choose deployment profile',

  async check(state) {
    if (state.data['__profile_locked'] === true) {
      return { done: true, reason: `profile locked from --profile flag (${state.profile})` };
    }
    if (state.completedSteps.includes('00-profile-mode')) {
      return { done: true, reason: `profile=${state.profile}` };
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
    return { data: {} };
  },

  async verify(state) {
    if (state.profile === 'solo' || state.profile === 'hobbyist') {
      return { ok: true, details: `profile=${state.profile}` };
    }
    return { ok: false, details: `unexpected profile=${state.profile}` };
  },
};
