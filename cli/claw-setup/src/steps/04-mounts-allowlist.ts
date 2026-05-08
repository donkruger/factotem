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
    // Pass --empty so mounts.ts writes a sane-default allowlist
    // (no allowedRoots, nonMainReadOnly: true) without prompting.
    //
    // Without --empty, mounts.ts falls through to `readFileSync(0)`
    // which blocks on stdin forever — the wizard's `runCommand`
    // spawns children with a piped (but unwritten) stdin, so the
    // call hangs indefinitely. The orchestrator-side mounts.ts has
    // three modes (--empty / --json / stdin); the wizard uses
    // --empty as the safe default and tells the operator how to
    // customise the allowlist later.
    const orchRoot = process.cwd();
    const result = await ui.runCommand('npx', [
      'tsx',
      path.join(orchRoot, 'setup', 'index.ts'),
      '--step',
      'mounts',
      '--',
      '--empty',
    ]);

    if (result.code !== 0) {
      ui.warn(
        `setup --step mounts exited ${result.code}. The wizard does not reimplement mount logic; rerun the underlying step manually if needed.`,
      );
    } else {
      ui.note(
        'Mount allowlist',
        'Wrote default empty allowlist to ~/.config/nanoclaw/mount-allowlist.json\n' +
          '(no allowedRoots, nonMainReadOnly: true).\n' +
          'To allow agents to read/write specific directories, edit that file later\n' +
          'or run: npx tsx setup/index.ts --step mounts --json \'{...}\' --force',
      );
    }

    return {};
  },

  async verify(_state) {
    // The underlying setup primitive owns its own verify; we don't duplicate.
    return { ok: true, details: 'mounts wrapper invoked' };
  },
};
