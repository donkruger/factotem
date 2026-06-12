/**
 * CLI wizard step 03b — collect credentials for the selected provider.
 *
 * Data-driven from `setup/providers.json`. Branches by auth_kind:
 *
 *   'api-key' — prompts for the API key, validates against the
 *               provider's models_endpoint, then registers it with
 *               OneCLI using the registry's host_pattern /
 *               header_name / value_format.
 *   'none'    — probes the local endpoint and advances.
 *   'oauth'   — out of scope this PR; warns and exits.
 *
 * Mirrors the GUI's `CredentialsStep.tsx`. Replaces the Anthropic-
 * hardcoded portion of the legacy `03-configure-onecli.ts` step.
 *
 * The OneCLI install + start + auth-login portion of the legacy step
 * still applies to all cloud providers (OneCLI is the credential
 * vault for every cloud provider's secret). This step assumes a prior
 * step has ensured OneCLI is running; for now we keep the install /
 * gateway-start / auth checks inline so the operator can complete a
 * fresh-machine setup in this one step.
 */

import * as clack from '@clack/prompts';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Step } from '../types.js';
import { loadProviderRegistry } from './03a-provider.js';

const ONECLI_URL = 'http://127.0.0.1:10254';

async function resolveOnecliCmd(ui: {
  runCommand: (
    cmd: string,
    args: string[],
  ) => Promise<{ stdout: string; stderr: string; code: number }>;
}): Promise<string | null> {
  const onPath = await ui.runCommand('which', ['onecli']);
  if (onPath.code === 0 && onPath.stdout.trim()) return 'onecli';
  const fallback = path.join(os.homedir(), '.local', 'bin', 'onecli');
  if (fs.existsSync(fallback)) return fallback;
  return null;
}

export const step: Step = {
  id: '03b-credentials',
  title: 'Connect to the chosen provider',

  async check(state) {
    if (state.completedSteps.includes('03b-credentials')) {
      return { done: true, reason: 'previously configured' };
    }
    return { done: false };
  },

  async execute(state, ui) {
    const registry = loadProviderRegistry();
    const protocol = state.provider_default?.protocol;
    if (!protocol) {
      throw new Error(
        'No provider selected. Run step 03a (provider) first.',
      );
    }
    const entry = registry[protocol];
    if (!entry) {
      throw new Error(`Unknown provider in registry: ${protocol}`);
    }

    if (entry.auth_kind === 'oauth') {
      ui.warn(
        `${entry.name} requires OAuth, which the wizard doesn't yet support. Pick a different provider for now.`,
      );
      throw new Error('OAuth providers not yet supported');
    }

    if (entry.auth_kind === 'none') {
      // Local provider — probe and advance.
      ui.step(step.id, `Detecting ${entry.name}…`);
      const probe = await ui.runCommand('curl', [
        '-sf',
        '-o',
        '/dev/null',
        '-m',
        '5',
        entry.models_endpoint,
      ]);
      if (probe.code !== 0) {
        ui.warn(
          `${entry.name} not reachable at ${entry.base_url}. Install/start it and re-run --resume.`,
        );
        throw new Error(`${entry.name} not reachable`);
      }
      ui.success(`${entry.name} is reachable.`);
      return { data: { credentials_kind: 'local' } };
    }

    // api-key flow: prompt → probe models_endpoint → register with OneCLI.
    if (!entry.onecli) {
      throw new Error(
        `Provider ${protocol} has no OneCLI config — can't register credentials.`,
      );
    }

    const apiKeyInput = await clack.password({
      message: `Paste your ${entry.name} API key`,
      validate(v) {
        if (!v || !v.trim()) return 'Please paste a key.';
        return undefined;
      },
    });
    if (clack.isCancel(apiKeyInput)) {
      throw new Error('Cancelled');
    }
    const apiKey = (apiKeyInput as string).trim();

    // Probe the provider's models_endpoint to verify the key works
    // before we register it with OneCLI. Same diagnostics shape the
    // GUI surfaces.
    //
    // Some providers reject probes missing a provider-specific header
    // even when auth is correct (Anthropic needs anthropic-version).
    // The runtime SDK inside the container sets these automatically;
    // we have to mirror them here for the curl-based probe. Listed on
    // the registry entry as `probe_headers`; absent means no extras.
    const headerValue = entry.onecli.value_format.replace('{value}', apiKey);
    const extraHeaderArgs: string[] = [];
    if (entry.probe_headers) {
      for (const [name, value] of Object.entries(entry.probe_headers)) {
        extraHeaderArgs.push('-H', `${name}: ${value}`);
      }
    }
    const probe = await ui.runCommand('curl', [
      '-sS',
      '-o',
      '/dev/null',
      '-w',
      '%{http_code}',
      '-m',
      '10',
      '-H',
      `${entry.onecli.header_name}: ${headerValue}`,
      ...extraHeaderArgs,
      entry.models_endpoint,
    ]);
    const status = parseInt(probe.stdout.trim(), 10) || 0;
    if (status === 401 || status === 403) {
      ui.error(
        `That key didn't authenticate against ${entry.name}. Common causes: typo, key revoked, project deleted.`,
      );
      throw new Error('API key did not authenticate');
    }
    if (status >= 400) {
      ui.error(
        `${entry.name} returned HTTP ${status} when validating the key.`,
      );
      throw new Error(`Validation failed (HTTP ${status})`);
    }
    if (status === 0) {
      ui.error(
        `Couldn't reach ${entry.name}. Check your internet connection.`,
      );
      throw new Error('Provider unreachable');
    }
    ui.success(`Connected to ${entry.name}.`);

    // Register the secret with OneCLI.
    const onecliBin = await resolveOnecliCmd(ui);
    if (!onecliBin) {
      ui.error(
        'onecli binary not found. Make sure OneCLI is installed and on PATH (~/.local/bin/onecli is the default location).',
      );
      throw new Error('onecli not found');
    }
    const reg = await ui.runCommand(onecliBin, [
      'secrets',
      'create',
      '--name',
      entry.onecli.name,
      '--type',
      'generic',
      '--value',
      apiKey,
      '--host-pattern',
      entry.onecli.host_pattern,
      '--path-pattern',
      '/*',
      '--header-name',
      entry.onecli.header_name,
      '--value-format',
      entry.onecli.value_format,
    ]);
    if (reg.code !== 0) {
      // If the secret already exists, treat as success.
      if (
        reg.stderr.includes('already exists') ||
        reg.stdout.includes('already exists')
      ) {
        ui.success(
          `${entry.onecli.name} credential already registered with OneCLI.`,
        );
        return { data: { credentials_kind: 'api-key', already_existed: true } };
      }
      ui.error(
        `onecli secrets create failed (exit ${reg.code}): ${reg.stderr.slice(
          -400,
        )}`,
      );
      throw new Error('OneCLI secret creation failed');
    }
    ui.success(`${entry.onecli.name} credential registered with OneCLI.`);

    return { data: { credentials_kind: 'api-key' } };
  },

  async verify(state) {
    // Light verification — the actual probe ran in execute(). Confirm
    // state moved forward.
    return { ok: true, details: `Credentials step complete (${state.provider_default?.protocol ?? '?'}).` };
  },
};
