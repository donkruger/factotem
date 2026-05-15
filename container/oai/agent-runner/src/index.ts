/**
 * NanoClaw OAI Agent Runner — entrypoint.
 *
 * Reads ContainerInput JSON from stdin, calls the configured
 * OpenAI-compatible endpoint via PROVIDER_BASE_URL, writes ContainerOutput
 * JSON to stdout between OUTPUT_START_MARKER / OUTPUT_END_MARKER lines.
 *
 * Same shape as the Claude agent-runner so the orchestrator parses both
 * containers' output identically. Cost in `cost_micros` so the dashboard's
 * cost panel can attribute spend per provider.
 *
 * Streaming mode (STREAM_MODE=sse): events also flow to stdout between
 * STREAM markers as they arrive from the upstream API. See streaming.ts.
 */

import { createClient, canonicalModelString, modelNameFromEnv } from './client.js';
import { TOOL_DEFINITIONS, executeToolCall } from './tools.js';
import { emitStreamEvent, isStreamMode, nextMessageId } from './streaming.js';
import type {
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
} from 'openai/resources/chat/completions';

// --- I/O contract ---------------------------------------------------------

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  groupName?: string;
  imageAttachments?: Array<{ relativePath: string; mediaType: string }>;
  script?: string;
  turnId?: string;
  agentProfile?: 'main' | 'standard' | 'open_dm';
  model?: string; // honoured if present, else env MODEL
}

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  model?: string;
  error?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  cost_micros?: number;
  started_at?: string;
  finished_at?: string;
  duration_ms?: number;
  duration_api_ms?: number;
  ttft_ms?: number;
  tool_use_count?: number;
  tool_error_count?: number;
  retry_count?: number;
  num_turns?: number;
  error_class?: string;
  prompt_chars?: number;
  response_chars?: number;
}

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

function log(turnId: string | undefined, message: string): void {
  const prefix = turnId ? `[oai-runner turnId=${turnId}]` : '[oai-runner]';
  console.error(`${prefix} ${message}`);
}

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

// --- Cost estimation ------------------------------------------------------
//
// Token → cost mapping is keyed off the canonical `<protocol>/<model>`
// string. Real production pricing is updated at release time; here we
// ship a conservative set of defaults so cost attribution surfaces are
// non-zero even on day one. When a model isn't in the table we report
// `cost_micros: 0` — the operator sees "free or cost unknown" rather
// than a misleading fabricated number.

interface ModelPrice {
  input_per_million_micros: number; // micro-USD per 1M input tokens
  output_per_million_micros: number;
}

const PRICE_TABLE: Record<string, ModelPrice> = {
  // Gemini compat-endpoint pricing as of 2026-05 (re-verify at release).
  'gemini/gemini-2.5-pro': {
    input_per_million_micros: 1_250_000,
    output_per_million_micros: 5_000_000,
  },
  'gemini/gemini-2.5-flash': {
    input_per_million_micros: 75_000,
    output_per_million_micros: 300_000,
  },
  // OpenAI placeholders — operators using OpenAI directly may want to
  // override at release time when GPT-5 final pricing settles.
  'openai/gpt-5.4': {
    input_per_million_micros: 2_500_000,
    output_per_million_micros: 10_000_000,
  },
};

function computeCostMicros(
  inputTokens: number | undefined,
  outputTokens: number | undefined,
): number {
  const key = canonicalModelString();
  const price = PRICE_TABLE[key];
  if (!price || inputTokens == null || outputTokens == null) return 0;
  const inCost = (inputTokens / 1_000_000) * price.input_per_million_micros;
  const outCost = (outputTokens / 1_000_000) * price.output_per_million_micros;
  return Math.round(inCost + outCost);
}

// --- Agent loop -----------------------------------------------------------

const MAX_TURNS = 6;

function systemPrompt(assistantName: string): string {
  return [
    `You are ${assistantName}, a helpful assistant that responds to WhatsApp messages on behalf of the operator.`,
    `Keep replies concise — WhatsApp is a short-message format. One or two paragraphs at most unless explicitly asked for more.`,
    `When you don't know something or the question depends on real-time information, prefer to use a tool. When no tool fits, answer honestly that you don't know.`,
    `Never invent URLs, phone numbers, or other facts you can't verify.`,
  ].join('\n\n');
}

async function runAgent(input: ContainerInput): Promise<ContainerOutput> {
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const assistantName =
    input.assistantName ?? process.env.ASSISTANT_NAME ?? 'Andy';
  const turnId = input.turnId;
  const messages: ChatCompletionMessageParam[] = [
    { role: 'system', content: systemPrompt(assistantName) },
    { role: 'user', content: input.prompt },
  ];

  log(turnId, `start model=${canonicalModelString()}`);
  if (isStreamMode()) {
    emitStreamEvent({
      type: 'message_start',
      messageId: nextMessageId(),
      model: canonicalModelString(),
    });
  }

  const client = createClient();
  const model = modelNameFromEnv();

  let turnCount = 0;
  let toolUseCount = 0;
  let toolErrorCount = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let firstTokenAt: number | null = null;

  try {
    while (turnCount < MAX_TURNS) {
      turnCount++;
      const apiT0 = Date.now();

      if (isStreamMode()) {
        // Streaming completion — emit content_block_delta as chunks arrive.
        const stream = await client.chat.completions.create({
          model,
          messages,
          tools: TOOL_DEFINITIONS,
          stream: true,
          stream_options: { include_usage: true },
        });
        let assistantText = '';
        const toolCalls: ChatCompletionMessageToolCall[] = [];
        for await (const chunk of stream) {
          if (firstTokenAt == null) firstTokenAt = Date.now();
          const choice = chunk.choices[0];
          if (!choice) continue;
          const delta = choice.delta;
          if (delta?.content) {
            assistantText += delta.content;
            emitStreamEvent({
              type: 'content_block_delta',
              delta: { text: delta.content },
            });
          }
          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index;
              if (toolCalls[idx] == null) {
                toolCalls[idx] = {
                  id: tc.id ?? '',
                  type: 'function',
                  function: {
                    name: tc.function?.name ?? '',
                    arguments: tc.function?.arguments ?? '',
                  },
                };
              } else {
                if (tc.function?.name) {
                  toolCalls[idx].function.name += tc.function.name;
                }
                if (tc.function?.arguments) {
                  toolCalls[idx].function.arguments += tc.function.arguments;
                }
                if (tc.id) toolCalls[idx].id = tc.id;
              }
            }
          }
          if (chunk.usage) {
            inputTokens = chunk.usage.prompt_tokens ?? inputTokens;
            outputTokens = chunk.usage.completion_tokens ?? outputTokens;
          }
        }
        // After the stream ends, decide whether the model called a tool
        // or produced a final answer.
        if (toolCalls.length > 0) {
          messages.push({
            role: 'assistant',
            content: assistantText || null,
            tool_calls: toolCalls,
          });
          for (const call of toolCalls) {
            emitStreamEvent({
              type: 'tool_use_start',
              name: call.function.name,
              input: safeParse(call.function.arguments),
            });
            const res = await executeToolCall(call);
            if (res.is_error) toolErrorCount++;
            toolUseCount++;
            emitStreamEvent({
              type: 'tool_use_result',
              output: res.output,
              is_error: res.is_error,
            });
            messages.push({
              role: 'tool',
              tool_call_id: res.tool_call_id,
              content: res.output,
            });
          }
          // Loop again for the model's follow-up turn.
          continue;
        }
        // No tool calls — assistantText is the final answer.
        const cost = computeCostMicros(inputTokens, outputTokens);
        emitStreamEvent({
          type: 'message_stop',
          tokenUsage: { input: inputTokens, output: outputTokens },
          cost_micros: cost,
        });
        return finaliseOutput({
          assistantText,
          startedAt,
          t0,
          firstTokenAt,
          turnCount,
          toolUseCount,
          toolErrorCount,
          inputTokens,
          outputTokens,
          promptChars: input.prompt.length,
          durationApiMs: Date.now() - apiT0,
        });
      } else {
        // Batch (non-streaming) completion.
        const resp = await client.chat.completions.create({
          model,
          messages,
          tools: TOOL_DEFINITIONS,
        });
        const apiDuration = Date.now() - apiT0;
        if (firstTokenAt == null) firstTokenAt = Date.now();
        const choice = resp.choices[0];
        const msg = choice?.message;
        if (!msg) {
          throw new Error('Provider returned an empty choices array');
        }
        if (resp.usage) {
          inputTokens = resp.usage.prompt_tokens;
          outputTokens = resp.usage.completion_tokens;
        }
        if (msg.tool_calls && msg.tool_calls.length > 0) {
          messages.push({
            role: 'assistant',
            content: msg.content,
            tool_calls: msg.tool_calls,
          });
          for (const call of msg.tool_calls) {
            const res = await executeToolCall(call);
            if (res.is_error) toolErrorCount++;
            toolUseCount++;
            messages.push({
              role: 'tool',
              tool_call_id: res.tool_call_id,
              content: res.output,
            });
          }
          continue;
        }
        // No tool calls — final answer.
        return finaliseOutput({
          assistantText: msg.content ?? '',
          startedAt,
          t0,
          firstTokenAt,
          turnCount,
          toolUseCount,
          toolErrorCount,
          inputTokens,
          outputTokens,
          promptChars: input.prompt.length,
          durationApiMs: apiDuration,
        });
      }
    }
    // Hit the turn cap.
    return {
      status: 'error',
      result: null,
      model: canonicalModelString(),
      error: `Agent exceeded ${MAX_TURNS} turns without producing a final answer.`,
      error_class: 'turn_limit_exceeded',
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      duration_ms: Date.now() - t0,
      num_turns: turnCount,
      tool_use_count: toolUseCount,
      tool_error_count: toolErrorCount,
      prompt_chars: input.prompt.length,
    };
  } catch (err) {
    const e = err as Error & { status?: number; code?: string };
    log(turnId, `error: ${e.message}`);
    return {
      status: 'error',
      result: null,
      model: canonicalModelString(),
      error: e.message,
      error_class: classifyError(e),
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      duration_ms: Date.now() - t0,
      num_turns: turnCount,
      tool_use_count: toolUseCount,
      tool_error_count: toolErrorCount,
      prompt_chars: input.prompt.length,
    };
  }
}

interface FinaliseInput {
  assistantText: string;
  startedAt: string;
  t0: number;
  firstTokenAt: number | null;
  turnCount: number;
  toolUseCount: number;
  toolErrorCount: number;
  inputTokens: number;
  outputTokens: number;
  promptChars: number;
  durationApiMs: number;
}

function finaliseOutput(f: FinaliseInput): ContainerOutput {
  const finishedAt = new Date().toISOString();
  const t1 = Date.now();
  return {
    status: 'success',
    result: f.assistantText,
    model: canonicalModelString(),
    usage: {
      input_tokens: f.inputTokens,
      output_tokens: f.outputTokens,
    },
    cost_micros: computeCostMicros(f.inputTokens, f.outputTokens),
    started_at: f.startedAt,
    finished_at: finishedAt,
    duration_ms: t1 - f.t0,
    duration_api_ms: f.durationApiMs,
    ttft_ms: f.firstTokenAt ? f.firstTokenAt - f.t0 : undefined,
    tool_use_count: f.toolUseCount,
    tool_error_count: f.toolErrorCount,
    num_turns: f.turnCount,
    prompt_chars: f.promptChars,
    response_chars: f.assistantText.length,
  };
}

function classifyError(e: Error & { status?: number; code?: string }): string {
  // Map common provider failures into the seven error classes from
  // PROVIDER_PLAYBOOK § 7.5. The dashboard's error-diagnosis page reads
  // this field to pick the right operator-facing copy + recovery action.
  if (e.status === 401 || e.status === 403) return 'auth.invalid_key';
  if (e.status === 429) return 'quota.rate_limited';
  if (e.status === 404) return 'model.not_found';
  if (e.code === 'ENOTFOUND' || e.code === 'ECONNREFUSED' || e.code === 'ETIMEDOUT')
    return 'provider.unreachable';
  return 'unknown';
}

function safeParse(s: string): Record<string, unknown> {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

// --- Main ----------------------------------------------------------------

async function main(): Promise<void> {
  const stdin = await readStdin();
  let input: ContainerInput;
  try {
    input = JSON.parse(stdin) as ContainerInput;
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to parse stdin JSON: ${(err as Error).message}`,
      error_class: 'invalid_input',
      started_at: new Date().toISOString(),
      finished_at: new Date().toISOString(),
      duration_ms: 0,
    });
    process.exit(1);
  }
  const output = await runAgent(input);
  writeOutput(output);
  if (output.status === 'error') process.exit(1);
}

main().catch((err) => {
  writeOutput({
    status: 'error',
    result: null,
    error: `Unhandled exception in agent-runner: ${(err as Error).message}`,
    error_class: 'unhandled',
    started_at: new Date().toISOString(),
    finished_at: new Date().toISOString(),
    duration_ms: 0,
  });
  process.exit(1);
});
