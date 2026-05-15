/**
 * CLI wizard step 03a — pick AI provider.
 *
 * Data-driven from `setup/providers.json` (Gemini blueprint PR 2). Mirrors
 * the GUI's `ProviderStep.tsx`. Operator picks one provider; the choice
 * lands in `state.agents[is_default].provider` + the legacy
 * `state.provider_default` mirror.
 *
 * On a v1/v2 install this step replaces the implicit "Anthropic always"
 * assumption of the legacy step 03-configure-onecli. After this PR the
 * Anthropic path is one card among several (cards added via JSON, not
 * code).
 *
 * See docs/PROVIDER_PLAYBOOK.md § 4.2 (Wizard contract) and
 * docs/implementation/gemini-blueprint.md § 6.5 (Phase D — CLI mirror).
 */

import * as clack from '@clack/prompts';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { Step } from '../types.js';

interface ProviderRegistryEntry {
  name: string;
  tagline: string;
  wire_protocol: 'anthropic' | 'openai-compatible';
  base_url: string;
  auth_kind: 'api-key' | 'none' | 'oauth';
  default_model: string;
  models_endpoint: string;
  key_signup_url?: string;
  key_format_hint?: string;
  onecli: {
    name: string;
    host_pattern: string;
    header_name: string;
    value_format: string;
  } | null;
  capabilities: {
    tool_use: string;
    vision: boolean;
    computer_use: boolean;
    prompt_caching: boolean;
    long_context: boolean;
    local: boolean;
  };
  container_image: string;
  ships_in: string;
  cost_hint: string;
}

type ProviderRegistry = Record<string, ProviderRegistryEntry>;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function loadProviderRegistry(): ProviderRegistry {
  // From cli/claw-setup/{src,dist}/steps/ walk up to the repo root,
  // then into setup/providers.json. Source-tree and dist-tree positions
  // both work.
  const candidates = [
    path.resolve(__dirname, '..', '..', '..', '..', 'setup', 'providers.json'),
    path.resolve(__dirname, '..', '..', '..', 'setup', 'providers.json'),
    path.resolve(process.cwd(), 'setup', 'providers.json'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      const raw = fs.readFileSync(c, 'utf8');
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const out: ProviderRegistry = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (k.startsWith('_') || k.startsWith('$')) continue;
        out[k] = v as ProviderRegistryEntry;
      }
      return out;
    }
  }
  throw new Error(
    `providers.json not found. Tried: ${candidates.join(', ')}`,
  );
}

export const step: Step = {
  id: '03a-provider',
  title: 'Pick AI provider',

  async check(state) {
    if (state.completedSteps.includes('03a-provider')) {
      return { done: true, reason: 'previously selected' };
    }
    return { done: false };
  },

  async execute(state, ui) {
    const registry = loadProviderRegistry();
    const protocols = Object.keys(registry);

    // Order: Anthropic first, then other cloud providers, then local.
    protocols.sort((a, b) => {
      if (a === 'anthropic') return -1;
      if (b === 'anthropic') return 1;
      const aLocal = registry[a].capabilities.local;
      const bLocal = registry[b].capabilities.local;
      if (aLocal !== bLocal) return aLocal ? 1 : -1;
      return registry[a].name.localeCompare(registry[b].name);
    });

    const options = protocols.map((p) => ({
      value: p,
      label: registry[p].name,
      hint: registry[p].tagline,
    }));

    const choice = await clack.select({
      message: 'Pick the AI provider this deployment uses by default',
      options,
      initialValue: 'anthropic',
    });

    if (clack.isCancel(choice)) {
      throw new Error('Cancelled');
    }
    const protocol = choice as string;
    const entry = registry[protocol];
    ui.success(`Chose ${entry.name} (${entry.default_model}).`);

    const provider = {
      protocol,
      model: entry.default_model,
      base_url: entry.capabilities.local ? entry.base_url : null,
      credential_id: entry.onecli?.name ?? null,
    };

    // Mutate state in place — matches the convention in 00-profile-mode.ts.
    // The runner persists `state` after execute() returns.
    state.agents = state.agents.map((a) =>
      a.is_default ? { ...a, provider } : a,
    );
    state.provider_default = provider;

    return {
      data: {
        provider_protocol: protocol,
        provider_model: entry.default_model,
      },
    };
  },

  async verify(state) {
    const proto = state.provider_default?.protocol;
    if (!proto) return { ok: false, details: 'provider_default not set' };
    const defaultAgent = state.agents.find((a) => a.is_default);
    if (!defaultAgent || defaultAgent.provider.protocol !== proto) {
      return { ok: false, details: 'default agent provider not in sync' };
    }
    return { ok: true, details: `Provider set to ${proto}.` };
  },
};
