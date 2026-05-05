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

    const result = await ui.runCommand(buildScript, []);
    if (result.code !== 0) {
      ui.error(`container build failed (exit ${result.code}).`);
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
    ui.success(`container image built — tag: ${tag}`);
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
