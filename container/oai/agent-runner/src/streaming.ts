/**
 * SSE event emission for the OAI agent-runner.
 *
 * Implements the streaming event taxonomy from PROVIDER_PLAYBOOK § 4.5.
 * The shape is Anthropic-flavoured (because Anthropic's stream protocol
 * is the most expressive of the three majors); OpenAI-compatible
 * upstream streams are translated into this taxonomy on the way out.
 *
 * Consumers today: the model-switch modal's sandboxed-test screen
 * (Gemini blueprint § 7.4), the provider health card's "Test →" action.
 *
 * Consumers tomorrow (deferred but unblocked by this contract): the
 * embedded CLI chat in the dashboard.
 */

export type StreamEvent =
  | { type: 'message_start'; messageId: string; model: string }
  | { type: 'content_block_delta'; delta: { text: string } }
  | {
      type: 'tool_use_start';
      name: string;
      input: Record<string, unknown>;
    }
  | { type: 'tool_use_result'; output: string; is_error: boolean }
  | {
      type: 'message_stop';
      tokenUsage: { input: number; output: number };
      cost_micros: number;
    };

/**
 * Marker pair around streamed events so the orchestrator can scrape
 * them out of stdout alongside the final OUTPUT envelope. Reuses the
 * same OUTPUT markers as batch mode — the orchestrator's parser
 * already handles multiple envelopes per container lifetime.
 */
const STREAM_START_MARKER = '---NANOCLAW_STREAM_START---';
const STREAM_END_MARKER = '---NANOCLAW_STREAM_END---';

export function isStreamMode(): boolean {
  return process.env.STREAM_MODE === 'sse';
}

export function emitStreamEvent(event: StreamEvent): void {
  if (!isStreamMode()) return;
  // One event per line, wrapped in a streaming marker pair so the
  // orchestrator's stream parser can find them. JSON-encoded.
  // eslint-disable-next-line no-console
  console.log(STREAM_START_MARKER);
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(event));
  // eslint-disable-next-line no-console
  console.log(STREAM_END_MARKER);
}

let messageIdCounter = 0;

/**
 * Generate a stable-per-process message id. Cryptographic randomness is
 * overkill here — we just need unique-per-message for audit-log
 * correlation within a single container's lifetime.
 */
export function nextMessageId(): string {
  return `msg-${Date.now()}-${++messageIdCounter}`;
}
