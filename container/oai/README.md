# nanoclaw-agent-oai

OpenAI-compatible wire-protocol container. One image, many providers.

## What it talks to

Anything that speaks the OpenAI `/chat/completions` shape:

- Gemini (via Google's `v1beta/openai` compat endpoint)
- OpenAI itself
- OpenRouter
- Together AI
- Groq
- Ollama (local, `http://localhost:11434/v1`)
- vLLM (local, self-hosted)
- Any future endpoint that ships a compatible API

The container does not know which of these it's talking to. The
orchestrator sets `MODEL` and `PROVIDER_BASE_URL` at spawn time; OneCLI
injects the right `Authorization: Bearer <key>` header on the way out
for cloud providers. Local providers (Ollama / vLLM) skip OneCLI and
call the local URL directly.

## Env vars

| Var | Purpose |
|---|---|
| `MODEL` | Full `<protocol>/<model>` string, e.g. `gemini/gemini-2.5-pro`. The container strips the prefix and sends the model name to the upstream API. |
| `PROVIDER_BASE_URL` | OpenAI-compatible base URL, e.g. `https://generativelanguage.googleapis.com/v1beta/openai`. The OpenAI SDK is instantiated with this as `baseURL`. |
| `ONECLI_GATEWAY` | `http://host.docker.internal:10254`. The SDK routes outbound HTTPS through this proxy; OneCLI injects the credential on the way. Absent for local providers. |
| `ASSISTANT_NAME` | Persona name. Surfaced in the system prompt. |
| `AGENT_ID` | Stable agent slug — used for per-agent memory namespacing. |
| `AGENT_NAME` | Same as `ASSISTANT_NAME` (kept for forward-compat with multi-agent containers). |
| `MEMORY_PATH` | `agents/<agent_id>` — where the agent's per-agent CLAUDE.md lives, relative to /workspace/group. |
| `STREAM_MODE` | When set to `sse`, the container emits Server-Sent-Events-shaped events to stdout in addition to the final OUTPUT envelope. See [`docs/PROVIDER_PLAYBOOK.md § 4.5`](../../docs/PROVIDER_PLAYBOOK.md#45-streaming-event-protocol-forward-compatibility). |

## Input / output contract

Stdin: a single `ContainerInput` JSON object. Same shape as the Claude
container's input. The orchestrator's `container-runner.ts`
builds it; container-side parsing is straight-through.

Stdout: streaming, wrapped in `---NANOCLAW_OUTPUT_START---` and
`---NANOCLAW_OUTPUT_END---` markers. Same shape as the Claude container's
`ContainerOutput`. Cost is reported via `cost_micros` (computed from the
upstream's `usage` field when available).

In streaming mode, SSE-shaped JSON lines also appear on stdout, between
the same markers. Each event has a `type` (`message_start`,
`content_block_delta`, `tool_use_start`, `tool_use_result`,
`message_stop`) and follows the event taxonomy in the Playbook.

## Tool use

Implements the OpenAI function-calling shape on the way out, translating
upstream tool results into the same `toolCalls` array shape that the
orchestrator's audit log expects.

The default tool set is intentionally minimal (basic web fetch, file
read, time). Per-provider extensions arrive in later PRs.

## Build

```bash
./build.sh           # tags :latest + :<git-sha>
./build.sh v1.2.3    # tags :v1.2.3 + :<git-sha>
```

## Smoke test against Gemini

```bash
echo '{"prompt":"What is 2+2?","groupFolder":"test","chatJid":"test@g.us","isMain":false}' \
  | docker run -i --rm \
      -e MODEL=gemini/gemini-2.5-flash \
      -e PROVIDER_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai \
      -e ONECLI_GATEWAY=http://host.docker.internal:10254 \
      nanoclaw-agent-oai:latest
```

Expected: stdout contains a JSON object between OUTPUT markers with
`"replyText": "4"` (or similar) and `"cost_micros" > 0`.

## Streaming smoke test

```bash
echo '{"prompt":"Tell me about Cape Town in three short sentences.","groupFolder":"test","chatJid":"test@g.us","isMain":false}' \
  | docker run -i --rm \
      -e MODEL=gemini/gemini-2.5-flash \
      -e PROVIDER_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai \
      -e ONECLI_GATEWAY=http://host.docker.internal:10254 \
      -e STREAM_MODE=sse \
      nanoclaw-agent-oai:latest
```

Expected: a `message_start` event, multiple `content_block_delta`
events (one per token chunk), then `message_stop` with usage + cost,
all interleaved between OUTPUT markers as they're emitted.
