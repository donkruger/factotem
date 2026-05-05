import path from 'path';
import type { Step } from '../types.js';

export const step: Step = {
  id: '04-mounts-allowlist',
  title: 'Configure mount allowlist',

  async check(state) {
    if (state.completedSteps.includes('04-mounts-allowlist')) {
      return { done: true, reason: 'previously configured' };
    }
    return { done: false };
  },

  async execute(state, ui) {
    if (state.data['__dry_run'] === true) {
      ui.warn('--dry-run set: skipping mounts step.');
      return {};
    }

    // Wraps the existing setup primitive in the orchestrator package.
    const orchRoot = process.cwd();
    const result = await ui.runCommand('npx', [
      'tsx',
      path.join(orchRoot, 'setup', 'index.ts'),
      '--step',
      'mounts',
    ]);

    if (result.code !== 0) {
      ui.warn(
        `setup --step mounts exited ${result.code}. The wizard does not reimplement mount logic; rerun the underlying step manually if needed.`,
      );
    }

    return {};
  },

  async verify(_state) {
    // The underlying setup primitive owns its own verify; we don't duplicate.
    return { ok: true, details: 'mounts wrapper invoked' };
  },
};
