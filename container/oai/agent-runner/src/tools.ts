/**
 * Minimal tool-use loop for the OAI agent-runner.
 *
 * This is the v1.0 surface for non-Anthropic providers. The agent gets a
 * narrow set of tools — enough to be useful in WhatsApp conversations
 * (web fetch, current time) without inheriting the Claude container's
 * heavy surface (browser automation, PDF reader, MCP server, etc.).
 * Per-provider tool expansion is deferred to follow-up PRs.
 *
 * Schema follows OpenAI's function-calling shape:
 *   https://platform.openai.com/docs/guides/function-calling
 *
 * Tool definitions and runtime handlers live side-by-side here so the
 * "what tools does this container offer?" answer is a single file.
 */

import type { ChatCompletionTool, ChatCompletionMessageToolCall } from 'openai/resources/chat/completions';

export interface ToolResult {
  tool_call_id: string;
  output: string;
  is_error: boolean;
}

/**
 * OpenAI tool-definition objects the agent gets each turn. Keep this
 * list short — long tool lists waste context tokens and confuse models.
 */
export const TOOL_DEFINITIONS: ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'get_current_time',
      description:
        'Get the current date and time in the operator\'s local timezone. Use this when the user asks "what time is it" or any question that depends on the current moment.',
      parameters: {
        type: 'object',
        properties: {
          timezone: {
            type: 'string',
            description:
              'IANA timezone identifier, e.g. "Africa/Johannesburg". Defaults to the container\'s TZ env var if omitted.',
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_fetch',
      description:
        'Fetch the text content of a URL. Use sparingly — only when the user explicitly asks about a specific URL or when an authoritative answer requires checking a public web page.',
      parameters: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'The full URL to fetch (must include https://)',
          },
        },
        required: ['url'],
      },
    },
  },
];

/**
 * Execute a single tool call. Returns the result that will be fed back
 * to the model on the next turn as a `{role: 'tool', ...}` message.
 */
export async function executeToolCall(
  call: ChatCompletionMessageToolCall,
): Promise<ToolResult> {
  const { name, arguments: argsJson } = call.function;
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(argsJson);
  } catch {
    return {
      tool_call_id: call.id,
      output: `Tool call rejected — arguments were not valid JSON: ${argsJson}`,
      is_error: true,
    };
  }

  try {
    switch (name) {
      case 'get_current_time':
        return {
          tool_call_id: call.id,
          output: getCurrentTime(args['timezone'] as string | undefined),
          is_error: false,
        };
      case 'web_fetch':
        return {
          tool_call_id: call.id,
          output: await webFetch(args['url'] as string),
          is_error: false,
        };
      default:
        return {
          tool_call_id: call.id,
          output: `Unknown tool: ${name}`,
          is_error: true,
        };
    }
  } catch (err) {
    return {
      tool_call_id: call.id,
      output: `Tool "${name}" failed: ${(err as Error).message}`,
      is_error: true,
    };
  }
}

function getCurrentTime(timezone?: string): string {
  const tz = timezone ?? process.env.TZ ?? 'UTC';
  try {
    const formatter = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      dateStyle: 'full',
      timeStyle: 'long',
    });
    return formatter.format(new Date());
  } catch {
    // Fall back to UTC if the timezone string is invalid.
    return new Date().toISOString();
  }
}

async function webFetch(url: string): Promise<string> {
  if (!/^https?:\/\//.test(url)) {
    throw new Error(`URL must start with http:// or https:// — got: ${url}`);
  }
  // 10-second timeout; truncate response to 50k chars so a giant page
  // doesn't blow the context window.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent':
          'NanoClaw-Agent/1.0 (+https://github.com/donkruger/factotem)',
      },
    });
    const text = await res.text();
    if (text.length > 50_000) {
      return text.slice(0, 50_000) + '\n\n…[truncated]';
    }
    return text;
  } finally {
    clearTimeout(timeout);
  }
}
