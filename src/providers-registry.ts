/**
 * Orchestrator-side reader of `setup/providers.json`.
 *
 * The canonical JSON file lives at `nanoclaw/setup/providers.json` and is
 * read by both the orchestrator (this module) and the wizard's
 * `setup/onecli-providers.ts` helper. Both readers go through this file's
 * shape because the JSON is the contract — never edit one reader without
 * updating the other.
 *
 * See docs/PROVIDER_PLAYBOOK.md § 5.5 (Provider registry).
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { logger } from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// providers.json lives in `setup/` at the repo root. From either
// `dist/providers-registry.js` or `src/providers-registry.ts` we go up
// one level and then into setup/.
const PROVIDERS_JSON_PATH = path.resolve(
  __dirname,
  '..',
  'setup',
  'providers.json',
);

export interface ProviderRegistryEntry {
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
  /**
   * Optional headers the provider's models-endpoint probe needs that
   * aren't auth (e.g. `anthropic-version` on Anthropic). The runtime
   * SDK sets these automatically inside the agent container; this
   * field exists so the wizard's curl-based probe matches.
   */
  probe_headers?: Record<string, string>;
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

export interface ProviderRegistry {
  [protocol: string]: ProviderRegistryEntry;
}

let cachedRegistry: ProviderRegistry | null = null;

/**
 * Load the provider registry from disk. Cached after first read since
 * `providers.json` ships with the binary and doesn't change at runtime.
 *
 * Metadata keys (prefix `_` or `$`) are stripped so callers iterate over
 * real providers only.
 */
export function loadProviderRegistry(): ProviderRegistry {
  if (cachedRegistry) return cachedRegistry;
  let raw: string;
  try {
    raw = fs.readFileSync(PROVIDERS_JSON_PATH, 'utf8');
  } catch (err) {
    logger.error(
      { path: PROVIDERS_JSON_PATH, err: (err as Error).message },
      'Failed to read providers.json',
    );
    throw err;
  }
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const out: ProviderRegistry = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (key.startsWith('_') || key.startsWith('$')) continue;
    out[key] = value as ProviderRegistryEntry;
  }
  cachedRegistry = out;
  return out;
}

/** @internal — for tests only. */
export function _resetRegistryCache(): void {
  cachedRegistry = null;
}

/**
 * Look up a provider entry by protocol id. Throws if unknown — callers
 * that want a soft-fail should check membership in the registry first.
 */
export function getProvider(protocol: string): ProviderRegistryEntry {
  const registry = loadProviderRegistry();
  const entry = registry[protocol];
  if (!entry) throw new Error(`Unknown provider protocol: ${protocol}`);
  return entry;
}

/**
 * Resolve the canonical container image name (with `:latest` tag) for a
 * given protocol. The orchestrator's container-runner uses this to pick
 * which Docker image to spawn.
 */
export function getContainerImageForProtocol(protocol: string): string {
  return `${getProvider(protocol).container_image}:latest`;
}

/**
 * Which wire protocol does this provider use? Drives env-var shape
 * (Anthropic-native vs OpenAI-compatible) without callers needing to
 * know about individual providers.
 */
export function getWireProtocolForProtocol(
  protocol: string,
): 'anthropic' | 'openai-compatible' {
  return getProvider(protocol).wire_protocol;
}
