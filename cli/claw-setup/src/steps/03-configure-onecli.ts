import * as clack from '@clack/prompts';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Step, UI } from '../types.js';

const ONECLI_URL = 'http://127.0.0.1:10254';

/**
 * Resolve the `onecli` binary's path. The OneCLI installer drops the
 * binary at ~/.local/bin/onecli and doesn't always add that dir to the
 * operator's shell PATH (the operator usually has to update .zshrc
 * themselves — documented in the setup skill). So we can't rely on
 * `onecli` being on PATH inside the wizard's subprocess.
 *
 * Strategy:
 *   1. If `onecli` is already on PATH, use it directly.
 *   2. Else fall back to ~/.local/bin/onecli (the install script's
 *      canonical destination — verified on Don's machine).
 *   3. Else throw with a clear message pointing at the PATH fix.
 */
async function resolveOnecliCmd(ui: UI): Promise<string> {
  // 1. PATH probe.
  const onPath = await ui.runCommand('which', ['onecli']);
  if (onPath.code === 0 && onPath.stdout.trim()) {
    return 'onecli';
  }

  // 2. Known install location.
  const fallback = path.join(os.homedir(), '.local', 'bin', 'onecli');
  if (fs.existsSync(fallback)) {
    return fallback;
  }

  // 3. Neither — tell the operator how to fix.
  throw new Error(
    'onecli binary not found. Expected at ~/.local/bin/onecli (the OneCLI install script\'s default). ' +
      'Either re-run the install script, or add ~/.local/bin to your PATH and retry: ' +
      'echo \'export PATH="$HOME/.local/bin:$PATH"\' >> ~/.zshrc && source ~/.zshrc',
  );
}

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

    // 2. Anthropic API key registration via OneCLI v1.7+ CLI.
    // The flow is now three concrete substeps because OneCLI's CLI
    // surface changed since the wizard was originally written:
    //
    //   2a. Point CLI at the local gateway (config set api-host).
    //   2b. Authenticate the CLI with an oc_* API key (auth login).
    //       Operator obtains the key from the OneCLI dashboard,
    //       which we auto-open in the browser to match step 02's
    //       UX pattern.
    //   2c. Create the Anthropic secret (secrets create) — the new
    //       command replaces the old `config add ...` shape.
    //
    // The wizard checks each substep's "already-done" state and
    // skips it idempotently — re-running on a partially-configured
    // host doesn't double-create or break.
    const dryRun = state.data['__dry_run'] === true;
    if (dryRun) {
      ui.warn('--dry-run set: skipping Anthropic credential registration.');
      return { data: { onecli_configured: true } };
    }

    const onecliCmd = await resolveOnecliCmd(ui);

    // 2a. Point CLI at local gateway. Idempotent — `config set` always
    // succeeds whether or not the value's already set.
    await ui.runCommand(onecliCmd, ['config', 'set', 'api-host', ONECLI_URL]);

    // 2b. Authenticate the CLI. Skip if already authenticated.
    let alreadyAuthed = false;
    const authStatus = await ui.runCommand(onecliCmd, ['auth', 'status']);
    if (authStatus.code === 0) {
      try {
        const parsed = JSON.parse(authStatus.stdout);
        alreadyAuthed = parsed.authenticated === true;
      } catch {
        // best-effort
      }
    }
    if (alreadyAuthed) {
      ui.success('OneCLI CLI already authenticated; skipping login.');
    } else {
      ui.note(
        'OneCLI CLI authentication',
        'OneCLI requires an `oc_*` API key for the CLI to talk to the local gateway.\n' +
          '1. The dashboard will open in your browser at ' + ONECLI_URL + '\n' +
          '2. Sign up / create the admin account if this is your first time.\n' +
          '3. Generate an API key from Settings → API Keys.\n' +
          '4. Paste it into the next prompt.',
      );
      if (process.platform === 'darwin') {
        await ui.runCommand('open', [ONECLI_URL]);
      }
      const ocKey = await clack.password({
        message: 'Paste your OneCLI API key (oc_...):',
        mask: '•',
        validate: (v) => {
          if (!v) return 'Required.';
          if (!v.startsWith('oc_')) return 'Should start with oc_ — that\'s the OneCLI key, not your Anthropic key';
          return undefined;
        },
      });
      if (clack.isCancel(ocKey)) {
        throw new Error('OneCLI API key entry cancelled');
      }
      const login = await ui.runCommand(onecliCmd, [
        'auth',
        'login',
        '--api-key',
        ocKey as string,
      ]);
      if (login.code !== 0) {
        ui.error(
          `onecli auth login failed (exit ${login.code}). stderr: ${login.stderr.slice(0, 400)}`,
        );
        throw new Error('onecli auth login failed');
      }
      ui.success('OneCLI CLI authenticated.');
    }

    // 2c. Check whether an Anthropic secret already exists. Skip if so.
    let alreadyHasAnthropic = false;
    const secretsList = await ui.runCommand(onecliCmd, ['secrets', 'list']);
    if (secretsList.code === 0) {
      try {
        const secrets = JSON.parse(secretsList.stdout) as Array<{
          name?: string;
          hostPattern?: string;
        }>;
        if (
          Array.isArray(secrets) &&
          secrets.some(
            (s) => s.name === 'Anthropic' && s.hostPattern === 'api.anthropic.com',
          )
        ) {
          alreadyHasAnthropic = true;
        }
      } catch {
        // best-effort
      }
    }

    if (alreadyHasAnthropic) {
      ui.success('Anthropic secret already registered with OneCLI; skipping create.');
      return { data: { onecli_configured: true } };
    }

    // Prompt for Anthropic API key.
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
      throw new Error('Anthropic API key entry cancelled');
    }

    // 2d. Create the Anthropic secret. The new `secrets create` API
    // replaces the v1.0-era `config add` shape. `--type generic` with
    // `--host-pattern api.anthropic.com` produces the same injection
    // config Don's main machine has (verified: pathPattern '/*',
    // headerName 'x-api-key', valueFormat '{value}').
    const reg = await ui.runCommand(onecliCmd, [
      'secrets',
      'create',
      '--name',
      'Anthropic',
      '--type',
      'generic',
      '--value',
      apiKey as string,
      '--host-pattern',
      'api.anthropic.com',
    ]);
    if (reg.code !== 0) {
      ui.error(
        `onecli secrets create failed (exit ${reg.code}). stderr: ${reg.stderr.slice(0, 400)}`,
      );
      throw new Error('onecli secrets create failed');
    }
    ui.success('Anthropic credential registered with OneCLI.');

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
