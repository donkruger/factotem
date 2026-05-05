import * as clack from '@clack/prompts';
import type { Step } from '../types.js';

export const step: Step = {
  id: '02-install-prerequisites',
  title: 'Install missing prerequisites',

  async check(state) {
    const probes = state.data['prereqs'] as
      | Array<{ name: string; ok: boolean; installUrl: string }>
      | undefined;
    if (!probes) {
      return { done: true, reason: 'no prereq data — step 01 did not run' };
    }
    if (probes.every((p) => p.ok)) {
      return { done: true, reason: 'all prereqs already installed' };
    }
    return { done: false };
  },

  async execute(state, ui) {
    const probes = state.data['prereqs'] as
      | Array<{ name: string; ok: boolean; installUrl: string }>
      | undefined;
    if (!probes) {
      return {};
    }

    const missing = probes.filter((p) => !p.ok);

    for (const m of missing) {
      ui.note(
        `Install ${m.name}`,
        `Open install page in browser: ${m.installUrl}\n` +
          `Note: NanoClaw never auto-installs system tools. You'll do this part manually.`,
      );

      if (process.platform === 'darwin') {
        await ui.runCommand('open', [m.installUrl]);
      }

      const confirmed = await clack.confirm({
        message: `Have you installed ${m.name} and verified it works?`,
        initialValue: false,
      });
      if (clack.isCancel(confirmed) || !confirmed) {
        return { warning: `${m.name} not confirmed installed; rerun --resume after installing` };
      }
    }

    return {};
  },

  async verify(_state) {
    // We trust the operator's confirmation. Step 10 smoke-tests the full stack.
    return { ok: true, details: 'operator confirmed prereq installs' };
  },
};
