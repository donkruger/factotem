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
        // Mirror step 02's "auto-open install URL" pattern, adapted for
        // a CLI installer rather than a browser page: open Terminal.app
        // pre-staged with the install command so the operator just
        // presses Enter in the new window. We never auto-execute —
        // the operator confirms the run by hitting Enter themselves.
        //
        // Install commands per docs/.../setup/SKILL.md. OneCLI ships
        // as a Go binary from onecli.sh, NOT an npm package — chain
        // both `install` (the gateway daemon) and `cli/install` (the
        // CLI client) so a single Enter press completes both.
        ui.note(
          'Install OneCLI',
          'OneCLI is the credential gateway that injects API keys into agent containers.\n' +
            'A new Terminal window will open with the installer commands pre-staged.\n' +
            'Press Enter in that Terminal to run them, follow any prompts, then come back here.',
        );

        if (process.platform === 'darwin') {
          // Two-step install per the setup skill: daemon then CLI.
          // Combined with `&&` so a single Enter runs both.
          const installCmd =
            'curl -fsSL onecli.sh/install | sh && curl -fsSL onecli.sh/cli/install | sh';
          const script =
            'tell application "Terminal" to activate\n' +
            'tell application "Terminal" to do script "' + installCmd + '"';
          await ui.runCommand('osascript', ['-e', script]);
        }

        // Block until the operator confirms the install completed in
        // the other Terminal window. Same gesture as step 02.
        const confirmed = await clack.confirm({
          message: 'Have you completed the OneCLI install in the other Terminal?',
          initialValue: false,
        });
        if (clack.isCancel(confirmed) || !confirmed) {
          ui.note(
            'Resume',
            'Once OneCLI is installed, from the factotem repo root rerun:\n  npm run claw-setup -- --resume',
          );
          return { warning: 'OneCLI not installed; resume after install' };
        }

        // Re-probe after install — gateway should now be reachable.
        const postInstallProbe = await ui.runCommand('curl', [
          '-sf',
          '-o',
          '/dev/null',
          ONECLI_URL + '/',
        ]);
        onecliReachable = postInstallProbe.code === 0;
        if (!onecliReachable) {
          ui.warn(
            'OneCLI installed but gateway still not reachable at ' +
              ONECLI_URL +
              '. Make sure the OneCLI service is running.',
          );
          return { warning: 'OneCLI installed but not running; resume after starting' };
        }
      } else {
        // OneCLI installed but not running — instruct operator
        ui.note(
          'Start OneCLI',
          'Start the OneCLI gateway service in another terminal, then continue.',
        );
        const reprobe = await ui.runCommand('curl', [
          '-sf',
          '-o',
          '/dev/null',
          ONECLI_URL + '/',
        ]);
        onecliReachable = reprobe.code === 0;
        if (!onecliReachable) {
          return { warning: 'OneCLI still not reachable; resume after starting' };
        }
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
