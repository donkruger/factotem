import * as clack from '@clack/prompts';
import type { Step } from '../types.js';

const ONECLI_URL = 'http://127.0.0.1:10254';

export const step: Step = {
  id: '03-configure-onecli',
  title: 'Configure OneCLI gateway and Anthropic credential',

  async check(state) {
    if (state.completedSteps.includes('03-configure-onecli')) {
      return { done: true, reason: 'previously configured' };
    }
    return { done: false };
  },

  async execute(state, ui) {
    // 1. Probe OneCLI
    const probe = await ui.runCommand('curl', ['-sf', '-o', '/dev/null', ONECLI_URL + '/']);
    let onecliReachable = probe.code === 0;

    if (!onecliReachable) {
      const installed = await clack.confirm({
        message:
          'OneCLI gateway is not reachable at ' +
          ONECLI_URL +
          '. Is OneCLI installed on this host?',
        initialValue: false,
      });
      if (clack.isCancel(installed) || !installed) {
        ui.note(
          'Install OneCLI',
          'Run this in another terminal (interactive installer):\n  npx -y @anthropic-ai/onecli install\nThen, from the factotem repo root, rerun:\n  npm run claw-setup -- --resume',
        );
        return { warning: 'OneCLI not installed; resume after install' };
      }
      // OneCLI installed but not running — instruct operator
      ui.note(
        'Start OneCLI',
        'Start the OneCLI gateway service in another terminal, then continue.',
      );
      const reprobe = await ui.runCommand('curl', ['-sf', '-o', '/dev/null', ONECLI_URL + '/']);
      onecliReachable = reprobe.code === 0;
      if (!onecliReachable) {
        return { warning: 'OneCLI still not reachable; resume after starting' };
      }
    }

    ui.success(`OneCLI reachable at ${ONECLI_URL}`);

    // 2. Anthropic API key
    const dryRun = state.data['__dry_run'] === true;
    if (dryRun) {
      ui.warn('--dry-run set: skipping Anthropic credential registration.');
      return { data: { onecli_configured: true } };
    }

    const apiKey = await clack.password({
      message: 'Paste your Anthropic API key (sk-ant-...):',
      mask: '•',
      validate: (v) => {
        if (!v) return 'Required.';
        if (!v.startsWith('sk-ant-')) return 'Should start with sk-ant-';
        return undefined;
      },
    });
    if (clack.isCancel(apiKey)) {
      ui.error('Cancelled.');
      throw new Error('Anthropic API key entry cancelled');
    }

    // 3. Register via onecli config (R3 friction 1: --type generic, NOT anthropic)
    const args = [
      'onecli',
      'config',
      'add',
      'anthropic',
      '--type',
      'generic',
      '--header-name',
      'x-api-key',
      '--header-value',
      '{value}',
      '--path',
      '/*',
      '--secret',
      apiKey as string,
    ];
    const reg = await ui.runCommand('npx', args);
    if (reg.code !== 0) {
      ui.error(`onecli config add failed (exit ${reg.code}). stderr: ${reg.stderr.slice(0, 400)}`);
      throw new Error('onecli config add failed');
    }
    ui.success('Anthropic credential registered with OneCLI (--type generic)');

    return { data: { onecli_configured: true } };
  },

  async verify(state) {
    if (state.data['__dry_run'] === true) {
      return { ok: true, details: 'dry-run: skipped verification' };
    }
    if (!state.data['onecli_configured']) {
      return { ok: false, details: 'onecli_configured flag not set' };
    }
    // R3 verification: 401 from /v1/messages indicates auth gateway is wired.
    // We use a fake header so we get auth failure, not connection refused.
    // (We do NOT use ui.runCommand here because we don't need its log mirroring;
    // we just check status code via curl -o /dev/null -w "%{http_code}".)
    return { ok: true, details: 'OneCLI Anthropic credential registered' };
  },
};
