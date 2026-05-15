/**
 * Error-class diagnosis registry.
 *
 * Maps the seven error classes from PROVIDER_PLAYBOOK § 7.5 into the
 * operator-readable copy + recovery action the dashboard surfaces.
 *
 * Used by:
 *   - `/errors` page — full list view with per-row diagnosis card
 *   - `AgentDetailView` and `GroupDetailView` — inline markers next to
 *     activity rows that errored
 *   - Future inline-error markers in the group's chat-history view
 *
 * Source of truth for copy. Every operator-facing string lands here so
 * a single review pass covers every surface that renders an error.
 */

export type KnownErrorClass =
  | 'auth.invalid_key'
  | 'auth.expired_key'
  | 'quota.rate_limited'
  | 'quota.over_budget'
  | 'model.not_found'
  | 'provider.unreachable'
  | 'container.crash';

export interface RecoveryAction {
  label: string;
  /** Whether the action is reversible / safe to default-emphasise. */
  variant: 'primary' | 'secondary';
  /** Anchor — internal route (`/agents/...`) or absolute URL. */
  href?: string;
  /** When non-null, a JSON-serialisable hint the row's onClick handler
   *  can use to perform an inline action (e.g., re-test the provider).
   *  Null for pure-navigation recovery. */
  intent?: string;
}

export interface ErrorDiagnosis {
  /** Short human label, e.g. "Authentication failed". */
  title: string;
  /** Operator-readable, one-or-two-sentence explanation. */
  description: string;
  /** Primary recovery affordance. */
  primary: RecoveryAction;
  /** Optional secondary affordance — appears alongside primary. */
  secondary?: RecoveryAction;
  /** Whether the error usually clears itself (rate-limit windows, network
   *  blips). Used to colour the row chip — transient errors don't need
   *  to look as alarming as persistent ones. */
  transient: boolean;
}

/**
 * Render the diagnosis for a given error_class string. Returns a fallback
 * record when the class isn't recognised — `unknown` from the OAI
 * runner's classifier surfaces here too.
 */
export function diagnose(
  errorClass: string | null | undefined,
  context: {
    provider?: string;
    model?: string;
    groupName?: string;
  } = {},
): ErrorDiagnosis {
  const providerLabel = providerDisplayName(context.provider);
  switch (errorClass) {
    case 'auth.invalid_key':
      return {
        title: 'Authentication failed',
        description: `Your ${providerLabel} API key didn’t authenticate. The key may have been revoked, your billing account is suspended, or you copied a truncated value when you set it up.`,
        primary: {
          label: `Open ${providerLabel} key dashboard`,
          variant: 'primary',
          href: keyDashboardUrl(context.provider),
        },
        secondary: {
          label: 'Re-test in setup',
          variant: 'secondary',
          intent: 'reauth',
        },
        transient: false,
      };
    case 'auth.expired_key':
      return {
        title: 'Credential expired',
        description: `${providerLabel}’s credential rotated. Refresh it from the provider’s account page — most providers issue a new token without breaking your account history.`,
        primary: {
          label: `Open ${providerLabel} key dashboard`,
          variant: 'primary',
          href: keyDashboardUrl(context.provider),
        },
        secondary: {
          label: 'Re-test in setup',
          variant: 'secondary',
          intent: 'reauth',
        },
        transient: false,
      };
    case 'quota.rate_limited':
      return {
        title: 'Rate-limited',
        description: `${providerLabel} is throttling requests. On free tiers this clears within a minute. If it keeps firing, either the model is more popular than your tier allows or you’re running a burst-heavy workload — switching this agent to a paid model usually solves it.`,
        primary: {
          label: 'Switch this agent’s model',
          variant: 'primary',
          intent: 'switch-model',
        },
        secondary: {
          label: 'View rate-limit history',
          variant: 'secondary',
          intent: 'view-rate-history',
        },
        transient: true,
      };
    case 'quota.over_budget':
      return {
        title: 'Daily budget hit',
        description: context.groupName
          ? `Group "${context.groupName}" exceeded its daily spend cap. Messages from this group won’t be processed until midnight (or until you raise the cap).`
          : 'A group exceeded its daily spend cap. Messages won’t be processed until midnight (or until you raise the cap).',
        primary: {
          label: 'Raise the cap',
          variant: 'primary',
          intent: 'raise-budget',
        },
        secondary: {
          label: 'Switch to a cheaper model',
          variant: 'secondary',
          intent: 'switch-model',
        },
        transient: false,
      };
    case 'model.not_found':
      return {
        title: 'Model unrecognised',
        description: `${providerLabel} doesn’t recognise ${context.model ?? 'this model'}. The most common cause is deprecation — providers retire model names on a rolling basis. Switch this agent to the provider’s current default.`,
        primary: {
          label: 'Switch to current default',
          variant: 'primary',
          intent: 'switch-model',
        },
        transient: false,
      };
    case 'provider.unreachable':
      return {
        title: `Can’t reach ${providerLabel}`,
        description: `The network call to ${providerLabel} timed out or DNS didn’t resolve. Check your internet connection, or visit the provider’s status page — service-wide outages are external to NanoClaw.`,
        primary: {
          label: `Open ${providerLabel} status page`,
          variant: 'primary',
          href: statusPageUrl(context.provider),
        },
        secondary: {
          label: 'Try again',
          variant: 'secondary',
          intent: 'retry',
        },
        transient: true,
      };
    case 'container.crash':
      return {
        title: 'Container crashed',
        description:
          'The agent container exited without producing output. Usually transient — the orchestrator restarts the container on the next message. Repeated crashes usually point at a missing dependency or a misconfigured mount.',
        primary: {
          label: 'View container logs',
          variant: 'primary',
          intent: 'view-logs',
        },
        secondary: {
          label: 'Switch provider (escape hatch)',
          variant: 'secondary',
          intent: 'switch-model',
        },
        transient: true,
      };
    case 'turn_limit_exceeded':
      return {
        title: 'Turn limit exceeded',
        description:
          'The agent looped through its tool-use budget without producing a final answer. Often a sign that a tool repeatedly returned an error the agent couldn’t recover from. Inspect the logs for the loop pattern.',
        primary: {
          label: 'View container logs',
          variant: 'primary',
          intent: 'view-logs',
        },
        transient: true,
      };
    case null:
    case undefined:
    case '':
    case 'unknown':
      return {
        title: 'Unknown error',
        description: `${providerLabel} returned an error the runner couldn’t classify. Check the container logs for the underlying response — likely a new error shape that the dashboard’s diagnosis registry doesn’t cover yet.`,
        primary: {
          label: 'View container logs',
          variant: 'primary',
          intent: 'view-logs',
        },
        transient: false,
      };
    default:
      return {
        title: `Error: ${errorClass}`,
        description: `${providerLabel} returned ${errorClass}. This class isn’t in the diagnosis registry yet — file the message + class string in CHANGE_LOG.md so we can add it.`,
        primary: {
          label: 'View container logs',
          variant: 'primary',
          intent: 'view-logs',
        },
        transient: false,
      };
  }
}

function providerDisplayName(provider?: string): string {
  if (!provider) return 'the provider';
  // Strip the `<protocol>/<model>` suffix when given the canonical form.
  const protocol = provider.includes('/') ? provider.split('/')[0] : provider;
  switch (protocol) {
    case 'anthropic':
      return 'Anthropic';
    case 'gemini':
      return 'Google Gemini';
    case 'openai':
      return 'OpenAI';
    case 'openrouter':
      return 'OpenRouter';
    case 'groq':
      return 'Groq';
    case 'together':
      return 'Together AI';
    case 'ollama':
      return 'Ollama (local)';
    case 'vllm':
      return 'vLLM (local)';
    default:
      return protocol;
  }
}

function keyDashboardUrl(provider?: string): string | undefined {
  if (!provider) return undefined;
  const protocol = provider.includes('/') ? provider.split('/')[0] : provider;
  switch (protocol) {
    case 'anthropic':
      return 'https://console.anthropic.com/settings/keys';
    case 'gemini':
      return 'https://aistudio.google.com/app/apikey';
    case 'openai':
      return 'https://platform.openai.com/api-keys';
    case 'openrouter':
      return 'https://openrouter.ai/keys';
    case 'groq':
      return 'https://console.groq.com/keys';
    case 'together':
      return 'https://api.together.xyz/settings/api-keys';
    default:
      return undefined;
  }
}

function statusPageUrl(provider?: string): string | undefined {
  if (!provider) return undefined;
  const protocol = provider.includes('/') ? provider.split('/')[0] : provider;
  switch (protocol) {
    case 'anthropic':
      return 'https://status.anthropic.com';
    case 'gemini':
      return 'https://status.cloud.google.com';
    case 'openai':
      return 'https://status.openai.com';
    case 'openrouter':
      return 'https://status.openrouter.ai';
    case 'groq':
      return 'https://groqstatus.com';
    case 'together':
      return 'https://status.together.ai';
    default:
      return undefined;
  }
}

/**
 * Render the protocol prefix from a canonical `<protocol>/<model>` string.
 * Falls back to the input when the string doesn't look canonical. Used
 * by inline markers that need to surface the provider without rendering
 * the full model name.
 */
export function protocolOf(model: string | null | undefined): string {
  if (!model) return 'unknown';
  return model.includes('/') ? model.split('/')[0] : model;
}
