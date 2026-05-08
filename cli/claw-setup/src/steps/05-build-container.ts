import fs from 'fs';
import path from 'path';
import type { Step } from '../types.js';

export const step: Step = {
  id: '05-build-container',
  title: 'Build agent container image',

  async check(state) {
    if (state.completedSteps.includes('05-build-container')) {
      return { done: true, reason: 'previously built' };
    }
    return { done: false };
  },

  async execute(state, ui) {
    if (state.data['__dry_run'] === true) {
      ui.warn('--dry-run set: skipping container build.');
      return {};
    }

    const orchRoot = process.cwd();
    const buildScript = path.join(orchRoot, 'container', 'build.sh');
    if (!fs.existsSync(buildScript)) {
      ui.error(`container build script not found at ${buildScript}`);
      throw new Error('container build script missing');
    }

    // The Docker build takes 3–5 minutes during which `runCommand`
    // captures all output to the setup log file (silent on screen).
    // Without a heads-up + a heartbeat the wizard looks indistinguishable
    // from a hang. Don hit this on his external iMac and asked
    // "running or stuck?" — answer: running, but UX was bad.
    //
    // Tell the operator up front, then start a tick every 30s to
    // signal liveness while `runCommand` does its buffered thing.
    ui.note(
      'Building agent container',
      'This takes 3–5 minutes (Docker pulls base layers + builds the agent runner).\n' +
        'Output is buffered to the setup log file — to watch live progress in another terminal:\n' +
        '  tail -f ~/.config/nanoclaw/setup-*.log',
    );

    const startedAt = Date.now();
    const heartbeat = setInterval(() => {
      const secs = Math.round((Date.now() - startedAt) / 1000);
      const m = Math.floor(secs / 60);
      const s = secs % 60;
      const elapsed = m > 0 ? `${m}m ${s}s` : `${s}s`;
      // Use stderr-like raw print to avoid breaking the clack frame.
      process.stdout.write(`  · still building… (${elapsed} elapsed)\n`);
    }, 30_000);

    let result;
    try {
      result = await ui.runCommand(buildScript, []);
    } finally {
      clearInterval(heartbeat);
    }
    if (result.code !== 0) {
      ui.error(
        `container build failed (exit ${result.code}). Tail of stderr: ${result.stderr.slice(-400)}`,
      );
      throw new Error('container build failed');
    }

    // Surface SHA from .container-image-tag (best-effort)
    const tagPath = path.join(orchRoot, '.container-image-tag');
    let tag = '<unknown>';
    try {
      tag = (await fs.promises.readFile(tagPath, 'utf8')).trim();
    } catch {
      // best-effort
    }
    const secs = Math.round((Date.now() - startedAt) / 1000);
    ui.success(`container image built — tag: ${tag} (took ${secs}s)`);
    return { data: { container_image_tag: tag } };
  },

  async verify(state) {
    if (state.data['__dry_run'] === true) {
      return { ok: true, details: 'dry-run: skipped' };
    }
    const tag = state.data['container_image_tag'];
    return tag
      ? { ok: true, details: `image tag ${tag}` }
      : { ok: false, details: 'no container image tag recorded' };
  },
};
