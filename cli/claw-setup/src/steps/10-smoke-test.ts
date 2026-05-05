import * as clack from '@clack/prompts';
import type { Step } from '../types.js';

const HEALTH_URL = 'http://localhost:7842/health';

export const step: Step = {
  id: '10-smoke-test',
  title: 'Smoke test the deployment',

  async check(state) {
    if (state.completedSteps.includes('10-smoke-test')) {
      return { done: true, reason: 'smoke test previously passed' };
    }
    return { done: false };
  },

  async execute(state, ui) {
    if (state.data['__dry_run'] === true) {
      ui.warn('--dry-run set: skipping smoke test.');
      return {};
    }

    // Curl /health
    const healthResult = await ui.runCommand('curl', ['-sf', '-o', '/dev/null', HEALTH_URL]);
    if (healthResult.code === 0) {
      ui.success(`/health responded OK at ${HEALTH_URL}`);
    } else {
      ui.warn(
        `/health did not respond (curl exit ${healthResult.code}). The orchestrator may not be running yet — that is fine if you have not bootstrapped launchd.`,
      );
    }

    if (state.profile === 'hobbyist') {
      ui.note(
        'Local-echo simulation',
        'Hobbyist profile: a synthetic IPC message would round-trip to a synthetic reply here. Implement when wiring the local-echo channel for hobbyist profile.',
      );
      return { data: { smoke_health: healthResult.code === 0 } };
    }

    if (state.profile === 'solo') {
      const ready = await clack.confirm({
        message:
          'Send a real WhatsApp test message to your main group now. Press Y when sent (the wizard will not block on the response).',
        initialValue: true,
      });
      if (clack.isCancel(ready)) {
        return { warning: 'smoke test skipped by operator' };
      }
      ui.note(
        'Verify reply',
        'Watch logs/nanoclaw.log for ingestion and the agent reply. The wizard does not poll the DB to avoid creating timing dependencies on a live system.',
      );
    }

    return { data: { smoke_health: healthResult.code === 0 } };
  },

  async verify(_state) {
    return { ok: true, details: 'smoke test complete (advisory)' };
  },
};
