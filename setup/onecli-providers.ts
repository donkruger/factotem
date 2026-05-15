/**
 * OneCLI per-provider secret helper.
 *
 * Reads `setup/providers.json` and produces the right `onecli secrets create`
 * invocation for any given provider. The wizard's credentials step calls
 * `buildOnecliSecretArgs()` to materialise the command-line flags, then
 * shells out to `onecli` via its existing `runCommand` plumbing.
 *
 * This module exists so the wizard step is data-driven: adding the 9th
 * provider becomes a one-line append to `providers.json` rather than a
 * new branch in the credentials step.
 *
 * See docs/PROVIDER_PLAYBOOK.md § 4.4 (OneCLI contract).
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// providers.json is sibling to this file. Resolve via import.meta.url so it
// works in both ESM source (tsx) and compiled dist (CJS-emitted? — claw-setup
// builds with tsc; the path is the same relative to the .ts/.js file).
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROVIDERS_JSON_PATH = path.resolve(__dirname, 'providers.json');

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
 * Load the provider registry from disk. Cached after first read since the
 * file is shipped with the binary and doesn't change at runtime.
 */
export function loadProviderRegistry(): ProviderRegistry {
  if (cachedRegistry) return cachedRegistry;
  const raw = fs.readFileSync(PROVIDERS_JSON_PATH, 'utf8');
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  // Strip metadata keys (prefix `_` or `$`) so callers iterate over real
  // providers only.
  const out: ProviderRegistry = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (key.startsWith('_') || key.startsWith('$')) continue;
    out[key] = value as ProviderRegistryEntry;
  }
  cachedRegistry = out;
  return out;
}

/**
 * Reset the cached registry. Tests use this; runtime callers shouldn't.
 * @internal
 */
export function _resetRegistryCache(): void {
  cachedRegistry = null;
}

/**
 * Build the argv list for `onecli secrets create` for the given protocol's
 * credential. Caller is responsible for shelling out (the wizard's existing
 * `runCommand` helper handles execution + stderr capture).
 *
 * For local providers (`onecli === null`), returns null — the caller should
 * skip OneCLI registration entirely.
 *
 * Example:
 *   buildOnecliSecretArgs('gemini', 'AIza…')
 *   // ['secrets', 'create',
 *   //  '--name', 'Gemini',
 *   //  '--type', 'generic',
 *   //  '--value', 'AIza…',
 *   //  '--host-pattern', 'generativelanguage.googleapis.com',
 *   //  '--path-pattern', '/*',
 *   //  '--header-name', 'Authorization',
 *   //  '--value-format', 'Bearer {value}']
 */
export function buildOnecliSecretArgs(
  protocol: string,
  apiKey: string,
): string[] | null {
  const registry = loadProviderRegistry();
  const entry = registry[protocol];
  if (!entry) throw new Error(`Unknown provider protocol: ${protocol}`);
  if (!entry.onecli) return null; // Local provider — skip OneCLI.

  const { name, host_pattern, header_name, value_format } = entry.onecli;
  return [
    'secrets',
    'create',
    '--name',
    name,
    '--type',
    'generic',
    '--value',
    apiKey,
    '--host-pattern',
    host_pattern,
    '--path-pattern',
    '/*',
    '--header-name',
    header_name,
    '--value-format',
    value_format,
  ];
}

/**
 * Convenience helper: look up a provider entry by protocol id.
 * Throws if the protocol is unknown — callers that want a soft-fail
 * should check `protocol in loadProviderRegistry()` first.
 */
export function getProvider(protocol: string): ProviderRegistryEntry {
  const registry = loadProviderRegistry();
  const entry = registry[protocol];
  if (!entry) throw new Error(`Unknown provider protocol: ${protocol}`);
  return entry;
}

/**
 * Which container image does this provider's container_image field
 * resolve to (with the `:latest` tag appended)? Used by the orchestrator's
 * container-runner to pick the right image at spawn time.
 */
export function getContainerImageForProtocol(protocol: string): string {
  return `${getProvider(protocol).container_image}:latest`;
}

/**
 * Which wire protocol does this provider use? Drives the container-runner's
 * image selection without the runner needing to know about individual
 * providers.
 */
export function getWireProtocolForProtocol(
  protocol: string,
): 'anthropic' | 'openai-compatible' {
  return getProvider(protocol).wire_protocol;
}
