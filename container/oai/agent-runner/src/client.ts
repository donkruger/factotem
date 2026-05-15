/**
 * OpenAI SDK wrapper for the nanoclaw-agent-oai container.
 *
 * Reads PROVIDER_BASE_URL + ONECLI_GATEWAY from env, instantiates the
 * `openai` SDK pointed at the provider's compat endpoint, and routes
 * outbound HTTPS through the OneCLI gateway so credentials get injected
 * on the way out. The container never sees the raw API key.
 *
 * For local providers (Ollama, vLLM) ONECLI_GATEWAY is absent — the SDK
 * calls the local URL directly with no proxy.
 */

import OpenAI from 'openai';
import { ProxyAgent, setGlobalDispatcher } from 'undici';

/**
 * Construct the OpenAI client. The `apiKey` value is a placeholder —
 * the SDK requires *some* string in the constructor, but the real
 * credential is added by the OneCLI proxy on the way out. For local
 * providers we still pass a placeholder so the SDK doesn't refuse to
 * construct.
 */
export function createClient(): OpenAI {
  const baseURL = process.env.PROVIDER_BASE_URL;
  if (!baseURL) {
    throw new Error(
      'PROVIDER_BASE_URL is required — the orchestrator sets it at spawn time',
    );
  }

  // OneCLI gateway routing. When the gateway is set, install a global
  // undici dispatcher so the OpenAI SDK's fetch implementation routes
  // through the proxy. The gateway intercepts the outbound request,
  // matches the host pattern, and injects the credential header.
  const gateway = process.env.ONECLI_GATEWAY;
  if (gateway) {
    try {
      setGlobalDispatcher(new ProxyAgent(gateway));
    } catch (err) {
      // Don't crash the container if proxy setup fails — fall through
      // and let the first request error visibly with the operator-
      // facing error message instead of a cryptic boot failure.
      // eslint-disable-next-line no-console
      console.error(
        `[oai-runner] warning: failed to configure OneCLI proxy at ${gateway}: ${(err as Error).message}`,
      );
    }
  }

  return new OpenAI({
    baseURL,
    apiKey: 'injected-by-onecli-or-not-required-for-local',
  });
}

/**
 * Strip the protocol prefix from the canonical `<protocol>/<model>`
 * MODEL env var. Containers send the bare model name to upstream
 * APIs — OpenAI doesn't know about `gemini/gemini-2.5-pro`, it knows
 * about `gemini-2.5-pro`.
 */
export function modelNameFromEnv(): string {
  const full = process.env.MODEL;
  if (!full) {
    throw new Error('MODEL env var is required');
  }
  const slash = full.indexOf('/');
  return slash === -1 ? full : full.slice(slash + 1);
}

/**
 * Return the canonical `<protocol>/<model>` string for echo-back in the
 * output envelope. Audit log + dashboard surfaces use this format.
 */
export function canonicalModelString(): string {
  return process.env.MODEL ?? 'unknown/unknown';
}
