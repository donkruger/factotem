# Gemini Implementation Blueprint

Phase-by-phase instructional guide for adding Google Gemini as a
**second agent on the operator's machine** — alongside the existing
default Claude agent — in alignment with
[`PROVIDER_PLAYBOOK.md`](../PROVIDER_PLAYBOOK.md), the consolidated
"OpenAI-compatible wire protocol as the single non-Anthropic path"
architecture, and the agent-first taxonomy in
[Playbook § 0](../PROVIDER_PLAYBOOK.md#0-taxonomy--deployment--agents--groups).

> **Three-for-one.** This work also ships:
>
> 1. The `nanoclaw-agent-oai` container — the single image every
>    future OpenAI-compatible provider reuses (OpenAI, OpenRouter,
>    Together, Groq, Ollama, vLLM, etc.). Subsequent providers are
>    data-only additions to `setup/providers.json`.
> 2. The **agent-first data model** (agents table, agent_id FK on
>    groups/sessions, agent-aware container env). Every future
>    second-or-Nth agent reuses this; the Claude path's data gets
>    auto-migrated onto it transparently.
> 3. The dashboard's **agent-first navigation** (Agents page,
>    per-agent detail view, Add Agent flow). Foundation for the
>    organogram view in
>    [Playbook § 11.2](../PROVIDER_PLAYBOOK.md#112-agent-organogram-view).
>
> Subsequent agents (Echo on Ollama, etc.) are configuration-only —
> they don't repeat the architectural work below.

---

## 0. Pre-flight reading

Before you write a line of code, read these in order:

1. [`PROVIDER_PLAYBOOK.md`](../PROVIDER_PLAYBOOK.md) — the four
   contracts every provider satisfies. This blueprint operationalises
   that playbook for Gemini specifically.
2. [`PROVIDER_PLAYBOOK.md § 3 — Wizard flow integration`](../PROVIDER_PLAYBOOK.md#3-wizard-flow-integration)
   — the new `provider` + `credentials` step shape the wizard branch
   must satisfy.
3. [`PROVIDER_PLAYBOOK.md § 8 — Operator-language guide`](../PROVIDER_PLAYBOOK.md#8-operator-language-guide)
   — every visible string in this work must conform.
4. [`ui-ux-direction.md`](../ui-ux-direction.md) — the Factotem
   light-mode design tokens. New cards and forms reuse them.
5. Existing reference implementation:
   - `container/agent-runner/` (the Claude container) — copy its
     structure when building `nanoclaw-agent-oai`.
   - `cli/claw-setup-gui/src/main/services/onecli.ts` — the Anthropic
     OneCLI integration. Mirror its shape.
   - `cli/claw-setup-gui/src/renderer/src/steps/OneCLIStep.tsx` — the
     existing five-phase auth wizard. The new credentials step
     refactors this file into a data-driven version.

---

## 1. Architecture position

Gemini occupies one row in the `providers.json` registry and routes
through the openai-compat container:

```
Operator picks Gemini in the wizard
        │
        ▼
providers.json[gemini]
    wire_protocol: "openai-compatible"
    base_url:      "https://generativelanguage.googleapis.com/v1beta/openai"
    auth_kind:     "api-key"
    default_model: "gemini-2.5-pro"
        │
        ▼
Container spawned per chat group:
    image:     nanoclaw-agent-oai:<version>
    env MODEL: "gemini/gemini-2.5-pro"
    env PROVIDER_BASE_URL: "https://generativelanguage.googleapis.com/v1beta/openai"
        │
        ▼
Container makes OpenAI-style POST to
    https://generativelanguage.googleapis.com/v1beta/openai/chat/completions
    Authorization: Bearer <gemini-api-key>
    
    Authorization header injected by OneCLI
    on outbound proxy at 127.0.0.1:10254
```

**The container itself does not know it is talking to Gemini.** It
sees an OpenAI-compatible endpoint, sends OpenAI-shaped JSON, gets
OpenAI-shaped JSON back. Gemini-specific concerns (sign-up flow,
free-tier limits, model names) live in the wizard and the operator-
facing doc — not in container code.

---

## 2. Gemini facts (canonical)

The values every phase below references. Don't change these without
updating the file at the same time.

| Property | Value |
|---|---|
| Provider name | `gemini` (lowercase, the protocol identifier) |
| OpenAI-compatible base URL | `https://generativelanguage.googleapis.com/v1beta/openai` |
| Models endpoint | `${base_url}/models` |
| Auth header | `Authorization` |
| Auth value format | `Bearer {value}` |
| API key sign-up | https://aistudio.google.com/app/apikey |
| Free tier | 15 RPM, 1,500 RPD on `gemini-2.5-flash`; lower on `gemini-2.5-pro` |
| Default model | `gemini-2.5-pro` (best quality) |
| Speed-tier alternative | `gemini-2.5-flash` (10× faster, ~½ quality) |
| Vision support (via compat endpoint) | ✓ (`image_url` parts) |
| Tool use (via compat endpoint) | ✓ (OpenAI function-calling shape) |
| Prompt caching (via compat endpoint) | ✗ — Gemini-native feature, not exposed via OpenAI-compat |
| Computer use | ✗ |
| Code execution tool | ✗ (Gemini-native feature, not exposed via OpenAI-compat) |
| Long context | ✓ (up to 2 M tokens on `gemini-2.5-pro`) |
| Cost (1k input/output tokens, USD, as of writing) | $0.00125 / $0.005 for 2.5-pro; $0.000075 / $0.0003 for 2.5-flash |

> **Currency caveat.** Cost figures and rate limits are point-in-time
> snapshots. Re-verify at https://ai.google.dev/pricing before shipping;
> bump them in `providers.json` and this doc in the same commit.

---

## 3. Phase A — Build `nanoclaw-agent-oai` container

**Status when starting:** doesn't exist. **Status when finishing:**
generic OpenAI-compatible agent container ready to host Gemini (and
later OpenAI, OpenRouter, etc.) via env vars.

### 3.1 Files to create

```
container/oai/
├── Dockerfile
├── build.sh
├── README.md
└── agent-runner/
    ├── package.json
    ├── index.ts          (entrypoint)
    ├── client.ts         (OpenAI client wrapper)
    ├── tools.ts          (tool-use loop)
    └── tsconfig.json
```

### 3.2 Dockerfile (sketch)

Base it on `container/Dockerfile` (the Claude version). Replace the
Claude SDK install with `openai` (the Node SDK). Same Linux base,
same /workspace mount layout, same non-root user.

```dockerfile
# container/oai/Dockerfile
FROM node:22-bookworm-slim

# ... identical base setup to container/Dockerfile ...

WORKDIR /app
COPY agent-runner/package.json agent-runner/package-lock.json ./
RUN npm ci --omit=dev
COPY agent-runner/ ./

USER agent
ENTRYPOINT ["node", "index.js"]
```

`agent-runner/package.json` pins `openai@^4.x` (or whatever's current
when shipping). The OpenAI Node SDK accepts an arbitrary `baseURL` —
that's what makes it the universal OpenAI-compatible client.

### 3.3 Entrypoint contract

The container honours [`PROVIDER_PLAYBOOK.md § 4.1`](../PROVIDER_PLAYBOOK.md#41-container-contract):
read `/workspace/in.json`, write `/workspace/out.json`. Mirror the
Claude container exactly here — the only thing that changes is the
SDK underneath.

Required env vars the container reads:

| Env var | Purpose |
|---|---|
| `MODEL` | Full `<protocol>/<model>` string, e.g. `gemini/gemini-2.5-pro` |
| `PROVIDER_BASE_URL` | Where to send OpenAI-shaped requests (Gemini's compat endpoint) |
| `ONECLI_GATEWAY` | Outbound proxy at `http://host.docker.internal:10254`; OneCLI injects the API key |
| `ASSISTANT_NAME` | Persona name from setup-state |

The container does NOT receive the API key directly. OneCLI sits in
front and injects it. This rule is identical to Claude's flow.

### 3.4 `client.ts` — OpenAI SDK wrapper

```typescript
import OpenAI from 'openai'

export function createClient(): OpenAI {
  const baseURL = process.env.PROVIDER_BASE_URL
  if (!baseURL) throw new Error('PROVIDER_BASE_URL is required')

  return new OpenAI({
    baseURL,
    // The actual key is injected by OneCLI on the outbound request.
    // Pass a placeholder so the SDK doesn't reject the constructor.
    apiKey: 'injected-by-onecli',
    // Route through OneCLI's HTTP proxy.
    // OneCLI listens on http://127.0.0.1:10254 and intercepts outbound
    // calls whose Host matches the provider's host pattern.
    httpAgent: createOnecliAgent(process.env.ONECLI_GATEWAY!)
  })
}
```

### 3.5 Tool-use loop

OpenAI's function-calling schema and Anthropic's tool-use schema
differ in three significant ways:

| Aspect | Anthropic (Claude SDK) | OpenAI (compat) |
|---|---|---|
| Tool definition | `input_schema` (JSON Schema) | `parameters` (JSON Schema) |
| Tool-call result | Content block of type `tool_result` | Message with `role: "tool"` |
| Multiple tool calls per turn | Native | Native (since GPT-4.1; Gemini supports too) |

Implement the OpenAI-shaped loop in `tools.ts` and translate any
NanoClaw-shared tool definitions to OpenAI's `parameters` schema on
the way in. The reverse translation on the way out (collecting
results) follows the standard OpenAI tool-result protocol.

**Reference implementation note:** PicoClaw's tool-use loop in their
`openai/` adapter is a good shape to study —
https://github.com/sipeed/picoclaw/tree/main/pkg/adapter/openai.
Don't copy their Go code; read its pattern.

### 3.6 Build script

```bash
#!/bin/bash
# container/oai/build.sh
set -euo pipefail
TAG="${1:-$(node -p "require('../../package.json').version")}"
docker build -t "nanoclaw-agent-oai:${TAG}" -t "nanoclaw-agent-oai:latest" \
  -f Dockerfile .
echo "✓ Built nanoclaw-agent-oai:${TAG}"
```

### 3.7 Phase A acceptance

- [ ] `cd container/oai && ./build.sh` produces `nanoclaw-agent-oai:latest`
- [ ] **Batch mode.** Container runs against a real Gemini key + real `in.json`:
      `docker run --rm -e MODEL=gemini/gemini-2.5-flash \
       -e PROVIDER_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai \
       -e ONECLI_GATEWAY=http://host.docker.internal:10254 \
       -v $(pwd)/test-workspace:/workspace nanoclaw-agent-oai:latest`
- [ ] `out.json` contains a non-empty `replyText` and `cost_micros > 0`
- [ ] **Streaming mode.** Container runs the same scenario with
      `STREAM_MODE=sse` env set. The container writes the SSE event
      taxonomy from [`PROVIDER_PLAYBOOK.md § 4.5`](../PROVIDER_PLAYBOOK.md#45-streaming-event-protocol-forward-compatibility)
      to the stream socket: `message_start`, one or more
      `content_block_delta`, optional `tool_use_*` events, then
      `message_stop` with usage + cost.
- [ ] Tool-use smoke test passes (the container can invoke a stubbed
      `get_time` tool and get back the result, see Phase G § 9.1)
- [ ] In streaming mode, `tool_use_start` and `tool_use_result`
      events fire *as the tool runs*, not just at the end

---

## 4. Phase B — Orchestrator routing

**File to edit:** `src/container-runner.ts`

### 4.1 Image selection by wire_protocol

Currently `container-runner.ts` hardcodes the Claude image. The
change is to:

1. Read `group.container_config.provider` from the DB (or fall back
   to `setup-state.json#provider_default`).
2. Look up that provider's `wire_protocol` in `setup/providers.json`.
3. Map wire-protocol → container image:
   - `anthropic` → `nanoclaw-agent` (the existing Claude image, unchanged)
   - `openai-compatible` → `nanoclaw-agent-oai`
4. Spawn the image with the provider-specific env vars
   (`MODEL`, `PROVIDER_BASE_URL`, and either `ONECLI_GATEWAY` for cloud
   providers or nothing extra for local ones — Gemini is cloud).

### 4.2 Sketch

```typescript
// src/container-runner.ts
import providersRegistry from '../setup/providers.json'

function imageForProvider(p: ProviderConfig): string {
  const reg = providersRegistry[p.protocol]
  if (!reg) throw new Error(`Unknown provider protocol: ${p.protocol}`)
  switch (reg.wire_protocol) {
    case 'anthropic':       return 'nanoclaw-agent'
    case 'openai-compatible': return 'nanoclaw-agent-oai'
    default: throw new Error(`Unknown wire_protocol: ${reg.wire_protocol}`)
  }
}

function envForProvider(p: ProviderConfig): Record<string, string> {
  const reg = providersRegistry[p.protocol]
  return {
    MODEL: `${p.protocol}/${p.model}`,
    PROVIDER_BASE_URL: reg.base_url,
    ASSISTANT_NAME: state.assistantName,
    ...(reg.onecli ? { ONECLI_GATEWAY: 'http://host.docker.internal:10254' } : {})
  }
}
```

### 4.3 Phase B acceptance

- [ ] Existing groups on `anthropic` continue spawning `nanoclaw-agent`
      with identical env (no regression on Claude path)
- [ ] A new group registered with `provider: { protocol: 'gemini', ... }`
      spawns `nanoclaw-agent-oai` with `MODEL=gemini/gemini-2.5-pro`
      and `PROVIDER_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai`
- [ ] Unit test in `src/container-runner.test.ts` covers both protocols
- [ ] No raw API key ever appears in the container's environment

---

## 5. Phase C — OneCLI configuration

**Files to create / edit:**
- `setup/providers.json` (new file; first entry written here, future
  providers append to it)
- `setup/onecli-providers.ts` (helper that creates OneCLI secrets from
  registry entries)

### 5.1 First two entries in `providers.json`

```jsonc
{
  "anthropic": {
    "name": "Anthropic Claude",
    "tagline": "Strongest agentic quality. The default.",
    "wire_protocol": "anthropic",
    "base_url": "https://api.anthropic.com",
    "auth_kind": "api-key",
    "default_model": "claude-opus-4.6",
    "models_endpoint": "https://api.anthropic.com/v1/models",
    "key_signup_url": "https://console.anthropic.com/settings/keys",
    "key_format_hint": "Starts with sk-ant-",
    "onecli": {
      "name": "Anthropic",
      "host_pattern": "api.anthropic.com",
      "header_name": "x-api-key",
      "value_format": "{value}"
    },
    "capabilities": {
      "tool_use": "best", "vision": true, "computer_use": true,
      "prompt_caching": true, "long_context": true, "local": false
    },
    "container_image": "nanoclaw-agent",
    "ships_in": "v1.0",
    "cost_hint": "≈$2–4/day for a chatty WhatsApp group"
  },
  "gemini": {
    "name": "Google Gemini",
    "tagline": "Generous free tier. Long context up to 2M tokens.",
    "wire_protocol": "openai-compatible",
    "base_url": "https://generativelanguage.googleapis.com/v1beta/openai",
    "auth_kind": "api-key",
    "default_model": "gemini-2.5-pro",
    "models_endpoint": "https://generativelanguage.googleapis.com/v1beta/openai/models",
    "key_signup_url": "https://aistudio.google.com/app/apikey",
    "key_format_hint": "Long alphanumeric string from Google AI Studio",
    "onecli": {
      "name": "Gemini",
      "host_pattern": "generativelanguage.googleapis.com",
      "header_name": "Authorization",
      "value_format": "Bearer {value}"
    },
    "capabilities": {
      "tool_use": "strong", "vision": true, "computer_use": false,
      "prompt_caching": false, "long_context": true, "local": false
    },
    "container_image": "nanoclaw-agent-oai",
    "ships_in": "v1.2",
    "cost_hint": "Free tier covers light personal use. Paid: ~$0.50–2/day for chatty groups."
  }
}
```

### 5.2 `onecli-providers.ts` helper

```typescript
// setup/onecli-providers.ts
import providers from './providers.json'

export async function createOnecliSecret(
  protocol: string,
  apiKey: string
): Promise<void> {
  const reg = providers[protocol]
  if (!reg?.onecli) throw new Error(`No OneCLI config for ${protocol}`)
  const { name, host_pattern, header_name, value_format } = reg.onecli

  await runOnecli([
    'secrets', 'create',
    '--name', name,
    '--type', 'generic',
    '--value', apiKey,
    '--host-pattern', host_pattern,
    '--path-pattern', '/*',
    '--header-name', header_name,
    '--value-format', value_format
  ])
}
```

### 5.3 Phase C acceptance

- [ ] `setup/providers.json` exists with both `anthropic` and `gemini`
      entries
- [ ] Running `node -e "import('./setup/onecli-providers.js').then(m =>
      m.createOnecliSecret('gemini', 'test-key'))"` creates the
      `Gemini` secret in OneCLI's vault
- [ ] `onecli secrets list` shows both `Anthropic` and `Gemini` after
      a clean setup

---

## 6. Phase D — Wizard branches (GUI + CLI)

This phase is where the consolidation pays off the most. The
existing OneCLIStep is refactored into two data-driven steps —
`ProviderStep` and `CredentialsStep` — that pick up the new Gemini
entry in `providers.json` for free.

### 6.1 New GUI step — `ProviderStep`

**File:** `cli/claw-setup-gui/src/renderer/src/steps/ProviderStep.tsx`

Reads `providers.json`, renders one card per provider, recommends
Anthropic by default. The UI pattern is in [`PROVIDER_PLAYBOOK.md § 4.2`](../PROVIDER_PLAYBOOK.md#42-wizard-contract):

```
┌────────────────────────────────────────────┐
│ 🟧 Anthropic Claude            Recommended │
│                                              │
│ Strongest agentic quality. Cloud — needs an │
│ API key.                                     │
│                                              │
│ ✓ Best-in-class tools  ✓ Vision  ✓ Caching │
│ ≈$2–4/day for a chatty group                 │
└────────────────────────────────────────────┘

┌────────────────────────────────────────────┐
│ 🔷 Google Gemini                            │
│                                              │
│ Generous free tier. Long context up to 2M   │
│ tokens. Cloud — needs an API key.            │
│                                              │
│ ✓ Strong tools  ✓ Vision  ✓ 2M context     │
│ Free tier covers light personal use          │
└────────────────────────────────────────────┘
```

On commit, write the choice to setup-state:

```typescript
await api.state.patch({
  provider_default: {
    protocol: 'gemini',
    model: providers.gemini.default_model,
    base_url: null,            // cloud providers leave this null
    credential_id: 'Gemini'    // matches onecli.name
  }
})
```

### 6.2 New GUI step — `CredentialsStep`

**File:** `cli/claw-setup-gui/src/renderer/src/steps/CredentialsStep.tsx`

Reads `provider_default.protocol` from state. Branches:

| `auth_kind` | What the step does |
|---|---|
| `api-key` | Renders the existing five-phase auth flow, generalised — open the provider's `key_signup_url` in the browser, ask for the key, validate against `key_format_hint`, test against `models_endpoint`, register with OneCLI via the helper above. |
| `none` (Ollama, vLLM) | Auto-advances after a 250 ms probe to `models_endpoint`. Surfaces a toast: "Detected Ollama running with 3 models. Defaulting to llama3.3:70b." |
| `oauth` (future) | Out of scope for this PR. Stub the branch and surface "Coming soon." |

The existing OneCLIStep's Phase-4-flow (the Anthropic-key entry,
test connection, OneCLI register) becomes the `api-key` branch
implementation. Rename `OneCLIStep.tsx` → `CredentialsStep.tsx` and
pull the Anthropic-specific copy strings out into provider-specific
ones derived from `providers.json`.

### 6.2.5 Welcome-screen communication of model-agnosticism

The current welcome screen tagline is "Your WhatsApp AI assistant,
running on your own machine." It doesn't name the underlying model
nor signal that the operator can pick.

**New tagline copy** (in `WelcomeStep.tsx`):

```
Your WhatsApp AI assistant, running on your own machine.
Powered by Claude by default — switchable to Gemini, OpenAI, or
local models any time from the dashboard.
```

Why this matters: operators who hate cloud / want privacy / are
sensitive about which company gets their data need to know in the
first 5 seconds that they're not locked in. Hiding the model
identity inside step 5 of the wizard violates trust.

The provider-picker step (§ 6.1) then opens with: "Pick one to start
— you can change this any time after install."

### 6.3 Operator copy for Gemini (per [§ 8](../PROVIDER_PLAYBOOK.md#8-operator-language-guide))

```
Step title: Connect your Google AI Studio account

Body:
  Google's free tier covers most personal use (~1,500 messages per
  day on the fast model). You'll need an API key from Google AI
  Studio — free to create, no credit card required.

CTA:
  [Open Google AI Studio →]    opens https://aistudio.google.com/app/apikey

Field label:
  API key

Field placeholder:
  Paste your key from Google AI Studio

Help text under field:
  Looks like a long alphanumeric string. We test it before you continue.

Test button:
  Test connection

On success:
  ✓ Connected — found 23 models. Defaulting to gemini-2.5-pro.
  [auto-advance after 800ms]
```

### 6.4 Wizard step order update

**File:** `cli/claw-setup-gui/src/renderer/src/hooks/useWizard.ts`

```diff
 export type StepId =
   | 'welcome'
   | 'profile'
   | 'envCheck'
   | 'install'
-  | 'onecli'
+  | 'provider'      // NEW — picker
+  | 'credentials'   // RENAMED from 'onecli', now data-driven
   | 'mounts'
   ...
```

### 6.5 CLI wizard mirror

**File:** `cli/claw-setup/src/steps/03-provider.ts` (new) +
`03b-credentials.ts` (refactored from `03-configure-onecli.ts`)

`@clack/prompts`-based equivalents. Same registry-driven logic.

### 6.6 Phase D acceptance

- [ ] Fresh wizard run on a clean machine shows the Gemini card
      alongside Anthropic
- [ ] Picking Gemini → entering an invalid key → "Test connection"
      shows "That key didn't authenticate. Common causes: typo,
      key revoked, project deleted."
- [ ] Picking Gemini → entering a valid key → success toast →
      auto-advance to Mounts step
- [ ] Setup-state file ends with
      `provider_default.protocol === 'gemini'` after the run
- [ ] CLI wizard `npm run claw-setup -- --profile=solo` shows the
      same provider picker

---

## 7. Phase E — Dashboard

The dashboard is where operators **discover, evaluate, and switch**
providers post-install. A buried dropdown is not enough. Model-
switching is a first-class journey with its own dedicated page,
pre-switch confirmation, and post-switch verification.

### 7.1 Per-group provider chip (clickable entry point)

**File:** `dashboard/src/components/panels/GroupListTable.tsx`

Each row shows the canonical `<protocol>/<model>` string for that
group. The chip is **clickable** — clicking it opens the model-switch
modal (§ 7.4) for that group. Falls back to `provider_default` when
the group doesn't override; visually distinguished as "(default)"
in muted text so the operator sees inherited vs overridden at a
glance.

```
┌────────────────────────────────────────────────────┐
│ Family group         anthropic/claude-opus-4.6 ▾   │ ← clickable
│ Hobby experiments    gemini/gemini-2.5-pro     ▾   │
│ Work assistant       claude-opus-4.6 (default) ▾   │ ← inherited
└────────────────────────────────────────────────────┘
```

### 7.2 Provider health card v2

**File:** `dashboard/src/components/panels/cards/<Provider>Card.tsx`
(one per provider currently in use — Anthropic always present;
Gemini's card appears once any group uses it)

The original card showed only "reachable / not." The v2 card surfaces
the four things an operator actually needs to diagnose:

```
┌───────────────────────────────────────────────────┐
│ 🔷  Gemini                       ● Reachable      │
├───────────────────────────────────────────────────┤
│ Active groups                  2                   │
│ Today's spend                  $0.43 / $5.00 cap   │
│ Rate-limit status              13/15 RPM (free)    │
│ Errors in last 24h             1  (rate-limit)     │
│ Current default model          gemini-2.5-pro      │
│                                                     │
│ [View errors →]  [Switch model →]  [Test →]        │
└───────────────────────────────────────────────────┘
```

- **Active groups** clicks into a filtered group list (groups on
  Gemini).
- **Today's spend** is the rolled-up `cost_micros` from `out.json`.
  Shows free-tier indicator when applicable. Hides the cap if no
  daily-budget is configured.
- **Rate-limit status** comes from the most recent successful
  response's `x-ratelimit-*` headers (where the provider exposes
  them; Gemini does).
- **Errors in last 24h** is a count + category. Clicking it opens
  the audit log filtered to provider errors. [§ 7.5 Error diagnosis](#75-error-diagnosis--recovery-journeys).
- **Test** sends a "hello" message via the provider and shows the
  reply inline — pre-flight test the operator can run any time, not
  just at install.

### 7.3 Dedicated model-selection page (`/models`)

**File:** `dashboard/src/app/models/page.tsx` (new)

A first-class page in the dashboard's primary nav (sits between
"Groups" and "Persona"), titled **"Models."** Two zones:

**Zone 1 — "Your providers" (installed + configured)**. One card per
provider currently set up. Each card mirrors § 7.2's health card
shape with an additional **"Add to a group"** primary action.

**Zone 2 — "Available providers" (not yet configured)**. One card per
`providers.json` entry the operator hasn't yet set up. Each card has:

- Provider name + tagline (from `providers.json`)
- Capability badges
- Cost expectation
- **"Set up this provider"** CTA → opens a wizard-style flow in a
  modal (same `CredentialsStep` React component the install wizard
  uses; not a duplicated implementation). Reuses the operator-
  language guide's copy.

After setup, the provider moves from Zone 2 to Zone 1 without a
page refresh.

### 7.4 Model-switch modal (the journey)

**File:** `dashboard/src/components/panels/ModelSwitchModal.tsx`
(new)

This is the journey your criterion calls out explicitly. Triggered
from three places: the clickable group chip (§ 7.1), the Group Detail
page's "Provider" section, or the per-provider card's "Add to a
group" action.

Three sequenced screens inside the modal:

**Screen A — Pick a target provider.**

```
┌─────────────────────────────────────────────────────┐
│ Switch "Family group" from Anthropic Claude         │
│ ─────────────────────────────────────────────────── │
│                                                       │
│  Currently:  anthropic/claude-opus-4.6                │
│                                                       │
│  Switch to:                                           │
│  ◯ Stay on Anthropic Claude  — try a different model │
│    Available models: opus-4.6, sonnet-4.6, haiku-4   │
│                                                       │
│  ◯ Google Gemini             — compatible, see diff  │
│    gemini-2.5-pro, gemini-2.5-flash                  │
│                                                       │
│  ◯ Ollama (local)            — compatible, see diff  │
│    llama3.3:70b, qwen2.5:72b, deepseek-r1:8b        │
│                                                       │
│  Not yet set up:                                      │
│  + OpenAI                    — set up first          │
│                                                       │
│  [Cancel]                          [Show diff →]      │
└─────────────────────────────────────────────────────┘
```

The selected provider shows a **capability diff** below the radio
group before the operator commits — that's screen B.

**Screen B — Capability diff (the "if it's possible / if not"
transparency your criterion asks for).**

For every pair of providers, the diff renders the capability matrix
side-by-side, highlighting differences:

```
┌─────────────────────────────────────────────────────┐
│ Switching "Family group" to Gemini                  │
│ ─────────────────────────────────────────────────── │
│                                                       │
│ Capability       Claude (now)   Gemini (after)        │
│ Tool use         best           strong                │
│ Vision           ✓              ✓                     │
│ Computer use     ✓              ✗  ← lost             │
│ Prompt caching   ✓              ✗  ← lost             │
│ Long context     200K           2M ← gained           │
│ Cost/day est.    ~$3            ~$1                   │
│                                                       │
│ ⚠ This group has open-DM mode enabled, which uses    │
│   prompt caching. Switching to Gemini will increase  │
│   per-message cost ~3×. Consider raising the daily   │
│   budget cap from $5 to $15 if you switch.           │
│                                                       │
│ ✓ Conversation history is preserved across the       │
│   switch. The new model has full access to this      │
│   group's memory.                                     │
│                                                       │
│ [← Back]    [Send a test message first]   [Switch →] │
└─────────────────────────────────────────────────────┘
```

Three exits from screen B:
- **Back** — re-pick the target.
- **Send a test message first** — opens screen C.
- **Switch** — commits immediately; container rebuilds on next message.

**Screen C — Sandboxed test (optional).**

The operator sends a test message to the new provider *without
affecting the live group*. The orchestrator spawns a throwaway
container with the new provider's config, sends the test, and
**streams the reply back token-by-token** via the SSE event protocol
in [`PROVIDER_PLAYBOOK.md § 4.5`](../PROVIDER_PLAYBOOK.md#45-streaming-event-protocol-forward-compatibility).

The container writes a session row with `kind = 'sandboxed-test'`,
exchanges the message, then the row is discarded. No state mutation
to the live group's session, no impact on per-group memory.

This is the first dogfood of the streaming protocol — getting it
right here unlocks the future embedded-chat surface (§ 11.1 of the
playbook) without any container-side rework.

```
┌─────────────────────────────────────────────────────┐
│ Testing Gemini before switching                      │
│ ─────────────────────────────────────────────────── │
│                                                       │
│  Test prompt:  [What time is it in Cape Town?    ]    │
│  [Send test]                                          │
│                                                       │
│  Reply (gemini-2.5-pro, 1.2s, 412 tokens, $0.002):   │
│  ─────────────────────────────────────────────────── │
│  Cape Town is currently in SAST (UTC+2), so it's    │
│  about 14:23. Anything else?                          │
│  ─────────────────────────────────────────────────── │
│                                                       │
│  [Test another prompt]  [Back]  [Looks good — switch] │
└─────────────────────────────────────────────────────┘
```

This is the single biggest confidence-building win available — most
"is the new model good enough?" anxiety is resolved by *trying it*
in 5 seconds.

**Post-switch verification.** After commit:
1. The container rebuilds on the next inbound message.
2. The dashboard shows a banner: "Family group is now on
   gemini-2.5-pro. Send a message to verify."
3. The banner persists until the first successful exchange completes
   on the new provider, then dismisses with a quiet ✓.
4. Audit log entry written: `provider.switch`, `group: X`,
   `from: anthropic/claude-opus-4.6`, `to: gemini/gemini-2.5-pro`,
   `actor: dashboard`, `timestamp: …`.

### 7.5 Error diagnosis & recovery journeys

**File:** `dashboard/src/app/errors/page.tsx` (new), accessed from
the per-provider health card's "View errors →" link or from any
group's detail page.

Operators currently have no path from "my agent went silent" to
"here's why." This phase establishes one. Five error classes, each
with its own diagnosis copy + recovery action:

| Class | Symptom | Diagnosis copy | Primary recovery |
|---|---|---|---|
| `auth.invalid_key` | Provider returns 401 | "Your <Provider> API key didn't authenticate. The key may have been revoked, or your billing account is suspended." | Open provider's key dashboard; re-paste in CredentialsStep modal |
| `auth.expired_key` | Subscription-OAuth tokens rotate | "Your <Provider> credential rotated. Refresh it from the provider's account page." | Auto-trigger refresh via OneCLI; manual fallback link |
| `quota.rate_limited` | 429 / RESOURCE_EXHAUSTED | "<Provider> is rate-limiting requests. <14/15 RPM used this minute>. Free-tier limits or burst spike?" | Show rate-limit graph; offer to switch this group to a paid model |
| `quota.over_budget` | Today's spend > daily cap | "Group <name> hit its daily budget cap ($5.00). Messages from this group won't be processed until midnight." | Increase cap; or switch to a cheaper model; or wait |
| `model.not_found` | Model name returns 404 | "The model <name> isn't recognised by <Provider>. It may have been deprecated." | Offer to switch the group's default model to the provider's current default |
| `provider.unreachable` | Network / DNS / TLS | "Can't reach <Provider>. Check your internet connection or <provider>'s status page (link)." | Retry; show status-page link; offer temporary fallback to a different provider |
| `container.crash` | non-zero exit, no out.json | "The agent container crashed. This is usually a transient issue. Logs available below." | Restart group; copy logs button; "Switch provider" as escape hatch |

Each error's row in the page is expandable to show:
- Timestamp + group affected
- Full error response from the provider (collapsed by default — raw JSON)
- Recovery button(s)

Errors are also surfaced **inline in the group's chat-history view** —
not just on the errors page — so operators see "the agent didn't
respond because X" right where they expect the answer.

### 7.6 Capability-requirement re-evaluation

When an operator *enables* a feature that requires a capability
(open-DM mode requires prompt caching, image attachments require
vision support), the dashboard **re-checks every group's current
provider** and shows a warning for any mismatch.

Example: operator enables open-DM mode → the Open-DM settings page
shows "1 of 3 groups uses a provider without prompt caching: Hobby
experiments (Gemini). Open-DM will cost 3× more per message in
that group. [Adjust the budget or switch the model →]"

This runs in addition to the pre-commit banner at wizard time. The
capability-banner concept becomes a runtime guarantee, not just a
setup-time warning.

### 7.7 Phase E acceptance

- [ ] Group list shows the protocol chip for every group; chip is
      clickable
- [ ] Clicking a chip opens the ModelSwitchModal scoped to that group
- [ ] Capability diff screen renders a side-by-side table for any
      provider pair, highlighting gains/losses
- [ ] "Send a test message first" works without mutating live state
- [ ] Post-switch banner appears and dismisses on first successful
      reply
- [ ] Audit log records `provider.switch` events with from / to /
      actor / timestamp
- [ ] Models page lists installed providers (Zone 1) + available
      providers (Zone 2); "Set up this provider" reuses the wizard's
      `CredentialsStep`
- [ ] Error page surfaces the seven error classes with recovery actions;
      group chat-history view also renders inline error markers
- [ ] Capability-requirement re-evaluation fires when open-DM is
      enabled while any group uses a non-caching provider

---

## 8. Phase F — Operator-facing doc

**File:** `docs/providers/gemini.md` (new)

Audience: a non-technical operator who is choosing Gemini in the
wizard or considering switching one of their groups to Gemini.
Follows the operator-language guide in [§ 8 of the playbook](../PROVIDER_PLAYBOOK.md#8-operator-language-guide).

Structure (template; fill in with actual current cost / RPM figures
at write-time):

```markdown
# Google Gemini

## What you get
Strong tool use, image understanding, and the longest conversation
memory of any provider (up to 2 million tokens — about 3,000 pages
of text). Google's free tier covers most personal use without a
credit card.

## What you don't get
No prompt caching, no computer use, no native code execution. If
you need those, use Claude.

## How to get an API key
1. Open https://aistudio.google.com/app/apikey
2. Sign in with a Google account
3. Click "Create API key" — pick "Create API key in new project" the first time
4. Copy the long string starting with `AIza…`

## What it costs
- Free tier: 1,500 messages/day on `gemini-2.5-flash`, plenty for personal use
- Paid: $0.50–2/day for a chatty group on `gemini-2.5-pro`
- You only pay if you exceed free-tier rate limits or pick the paid model

## Switching a group to Gemini
On the Factotem dashboard → Groups → pick a group → Provider dropdown
→ select Google Gemini → save. The agent answers the next inbound
message using Gemini.

## Switching back
Same path. No data loss; the conversation continues.
```

---

## 9. Phase G — Acceptance tests

This is the full test suite that gates the Gemini PR. Every item
checked, in order.

### 9.1 Container smoke test
- [ ] Run `nanoclaw-agent-oai:latest` against a real Gemini key with
      an in.json that asks "What's 2 + 2?"
- [ ] out.json contains `"replyText"` whose content includes "4"
- [ ] `cost_micros` is non-zero

### 9.2 Tool-use test
- [ ] in.json contains a `get_time(timezone)` tool definition + a
      question that requires calling it
- [ ] out.json contains a `toolCalls` array with one entry for
      `get_time`
- [ ] The container's stdout log shows the tool result being fed back
      to the model for a follow-up turn

### 9.3 Cost-attribution test
- [ ] Send three messages via a Gemini group
- [ ] Dashboard's Cost panel shows three Gemini rows totalling
      `cost_micros` from out.json
- [ ] Anthropic group's costs are unaffected (no cross-attribution
      bugs)

### 9.4 Provider-switch test
- [ ] Group is currently on Anthropic. Switch it to Gemini via the
      dashboard's Group Config Editor.
- [ ] Send a new message. The orchestrator spawns
      `nanoclaw-agent-oai` instead of `nanoclaw-agent`.
- [ ] Send a follow-up referencing earlier conversation. The Gemini
      agent has access to the same per-group memory (CLAUDE.md and
      session SQLite) the Claude agent did.
- [ ] Switch back to Anthropic. Next message spawns Claude. No data
      loss.

### 9.5 Migration test
- [ ] On a v1 setup-state.json (pre-multi-provider operator),
      launch the wizard.
- [ ] Wizard reads the state, surfaces `provider_default = anthropic`
      automatically (no prompt re-asks the question).
- [ ] OneCLI's existing `Anthropic` secret is unchanged.
- [ ] After Phase D's commit, state file's `version` field reads `2`.

### 9.6 Capability-banner test
- [ ] Enable open-DM mode on a Gemini group.
- [ ] Before commit, the wizard surfaces:
      "⚠️ Gemini doesn't support prompt caching. Open-DM mode will
       cost ~3× more per message than on Claude."
- [ ] Operator can either accept and continue, or pick a different
      provider for this group.

### 9.7 Free-tier rate-limit handling
- [ ] Send 16 messages within one minute to a Gemini group on the
      free tier (`gemini-2.5-flash`).
- [ ] The 16th request returns Gemini's `RESOURCE_EXHAUSTED` error.
- [ ] The container catches this and writes `out.json` with
      `replyText: "I've hit Google's free-tier rate limit (15
      messages/min). Try again in a few seconds, or switch this group
      to a paid model in the Factotem dashboard."`
- [ ] The orchestrator does NOT crash; the group survives the rate-limit
      hit gracefully.

### 9.8 UX-copy review
- [ ] Read every visible string introduced by this PR.
- [ ] Run against [§ 8 operator-language guide](../PROVIDER_PLAYBOOK.md#8-operator-language-guide).
- [ ] No "tool use" → "can use tools". No "credential" → "API key".
      No "orchestrator" → "NanoClaw".
- [ ] Reviewer signs off before merge.

### 9.9 Clean-machine setup test (matches Playbook § 7.5)

The DMG must complete first-time setup on a Mac where nothing
AI-related has ever been installed. The acceptance bar:

- [ ] **Fresh macOS install** — clean account on a Mac that has
      never run Homebrew, Docker, OneCLI, or Node. Boot, sign in,
      mount the DMG, drag NanoClaw to Applications, launch.
- [ ] **Path budget: < 5 visible screens** on the fast path
      ("Set up NanoClaw" button) before Gemini API key entry. Each
      screen counted: welcome, provider, credentials, WhatsApp pair,
      ready.
- [ ] **Single install confirmation.** Wizard surfaces one prompt
      asking permission to install Docker via Homebrew. Operator
      clicks once; Docker arrives. No terminal, no brew command, no
      copy-paste.
- [ ] **No second restart.** The combined chain (Docker install →
      OneCLI install → Node-runtime probe → container build →
      WhatsApp pair) requires at most one logout/login or reboot.
- [ ] **Graceful brew-absent fallback.** Same test on a Mac that
      *has* Homebrew but where `brew install docker` fails (e.g. brew
      version too old). The wizard surfaces "Install Docker manually
      → download.docker.com/mac" with a one-click open-in-browser
      and resumes after the operator installs it.
- [ ] **Apple Container path.** On macOS 15+ with Apple Container
      installed but no Docker, the wizard detects it and asks
      "Apple Container detected — supported but uses a different CLI
      from Docker. Continue with Apple Container? [Yes] [Install
      Docker instead]" rather than reporting "Docker not found."
- [ ] **First message-to-reply latency under 2 minutes** from DMG
      mount to "the agent replied in WhatsApp" on a typical home
      broadband connection, excluding the operator's typing time for
      the API key.

### 9.10 Path-resolution test (matches Playbook § 4.7)

The wizard must successfully discover Node, Docker, OneCLI, and
Tailscale across the variants in § 4.7's matrices. Run this matrix
on at least three operator profiles before shipping:

- [ ] **Homebrew (Apple Silicon) operator** — Node at
      `/opt/homebrew/bin/node`. Wizard env-check shows green.
- [ ] **nvm operator** — Node at
      `~/.nvm/versions/node/v22.16.0/bin/node`, no system Node.
      Wizard env-check shows green; "Tools NanoClaw is using"
      disclosure shows the nvm path.
- [ ] **Volta operator** — Node shimmed at `~/.volta/bin/node`.
      Same check; same disclosure shows the Volta path.
- [ ] **asdf operator** — Node at `~/.asdf/shims/node`. Same check
      using `asdf which node` as fallback resolver. Same disclosure.
- [ ] **Conflict reconciliation** — operator has both Homebrew Node
      22.16 and nvm Node 18.19. Wizard surfaces the version-conflict
      banner from § 4.7, defaults to the newer, lets operator switch.
- [ ] **Docker Desktop** — `docker info` returns
      `Docker Desktop`; orchestrator uses `host.docker.internal`
      for local provider URLs.
- [ ] **OrbStack** — `docker info` returns `OrbStack`; orchestrator
      uses `host.docker.internal` (OrbStack supports the alias).
- [ ] **Colima** — `docker info` returns `colima`; orchestrator
      uses `host.docker.internal` (Colima with `--mount-type=9p`).
- [ ] **Podman** — when only `podman` is present, wizard detects it,
      surfaces "Podman detected — supported, falling back to
      `host.containers.internal` for local providers" and proceeds.
- [ ] **Finder-launched Electron test** — install the wizard,
      double-click from Finder (NOT from a shell). Confirm Tailscale,
      Docker, and Node all resolve. (This is the canonical
      regression test for the `findBin` contract.)
- [ ] **Override path** — operator clicks "Override paths →" on the
      env-check screen and types a non-default Node path. The
      override persists in `setup-state.json` and survives
      relaunches.

### 9.11 Apple-philosophy UX review (matches Playbook § 7.6)

Before PR 5 (the ModelSwitchModal) ships, run a structured review
against the 11 heuristics in § 7.6. Each heuristic is binary:

- [ ] **One primary action per screen.** Audit every new screen in
      this PR for two primary-styled CTAs; demote one if found.
- [ ] **Status rendered, not counted.** No "N errors in 24h"
      surfaces unless the click is wired to an action.
- [ ] **Deferred disclosure.** `gemini/gemini-2.5-pro`-shaped
      identifiers only surface under "Technical details"
      disclosures on detail pages.
- [ ] **Names beat IDs.** No agent IDs visible in chrome; "Andy"
      everywhere, `agent-andy-7f3a` only in tooltips and audit logs.
- [ ] **Health rolls up.** The Agents page shows one dot per agent;
      drill-down for per-group; drill-down again for per-call.
- [ ] **Direct manipulation.** Group-to-agent reassignment supports
      drag-and-drop in addition to the dropdown.
- [ ] **Instant feedback.** Click → visible response within 100 ms
      everywhere. Long-running actions show determinate progress.
- [ ] **Animations carry information.** Provider-chip pulse during
      container spawn; modal slide direction matches flow direction;
      no purely-decorative motion.
- [ ] **1280×800 fits the primary views.** Agents page, Models
      page, per-agent detail — all three render without vertical
      scroll on initial paint at MacBook Air resolution.
- [ ] **Empty states teach.** First-run Agents page, first-run
      Models page, first-run Errors page all carry didactic copy.
- [ ] **Destructive actions reversible.** Deleting an agent
      archives for 30 days; hard-delete is a second explicit action
      from the archive view.

### 9.12 UX review session

- [ ] Non-technical operator (someone who isn't Don and doesn't work
      on NanoClaw) walks through the fast-path install while the
      reviewer watches silently. Reviewer notes:
      - Every place the operator hesitated > 5 seconds
      - Every place the operator scrolled looking for an answer
      - Every word the operator misread or didn't understand
- [ ] Each note that fires more than once across multiple operators
      gets a copy / layout fix before merge.

---

## 9.5 Phase H — Agent-first data model & UI

Gemini ships as **the first second agent on the operator's machine**.
That means the work in this PR also lays the agent-first foundation
that every subsequent agent (Echo on Ollama, custom-persona Andy-2
on Claude, etc.) reuses.

### 9.5.1 Schema migration (one-time, runs on orchestrator startup)

- [ ] Detect missing `agents` table; create per [Playbook § 5.2](../PROVIDER_PLAYBOOK.md#52-database-schema-storemessagesdb)
- [ ] Synthesise the operator's existing setup into one default agent
      (`id` slugified from `assistantName`, `provider` from
      `provider_default`, `is_default = 1`)
- [ ] Add `agent_id` FK columns on `registered_groups` and `sessions`,
      backfill all rows to the default agent
- [ ] Bump `setup-state.json` to schema v3 per
      [Playbook § 10 Migration](../PROVIDER_PLAYBOOK.md#10-migration-from-anthropic-only),
      preserving legacy fields for older clients

### 9.5.2 Agent operations (orchestrator-side)

- [ ] `src/agents.ts` — CRUD helpers: `createAgent()`, `listAgents()`,
      `getAgent(id)`, `updateAgent(id, patch)`, `deleteAgent(id)`
      (delete cascades to reassigning groups to the default agent;
      never to orphan-then-delete)
- [ ] Provider-resolution chain in `src/container-runner.ts`:
      `group.container_config.provider ?? agent.provider ?? deployment.default_agent.provider`
- [ ] Container spawn now passes `AGENT_ID`, `ASSISTANT_NAME` (agent's
      name), and `MEMORY_PATH` (agent's namespace) as env vars in
      addition to the existing `MODEL` and `PROVIDER_BASE_URL`
- [ ] Memory path resolution: containers read CLAUDE.md via the
      fallback chain `groups/agents/<agent_id>/<folder>/CLAUDE.md
      ?? groups/<folder>/CLAUDE.md`

### 9.5.3 Routing — trigger-based agent dispatch

- [ ] `src/router.ts` — when a WhatsApp message arrives, scan for the
      `@<trigger>` prefix; if it matches any agent's
      `default_trigger`, dispatch to that agent's container even when
      the group is assigned to a different agent. (Per-message override
      via trigger; group's assigned agent is the default.)
- [ ] Multi-agent coexistence test: send `@Andy hi` and `@Ben hi`
      back-to-back in the same group; confirm two different containers
      spawn and two different agents respond.

### 9.5.4 Dashboard — Agent-first navigation

- [ ] `/agents` page becomes the dashboard's landing route (was
      `/health` / `/groups`); one card per agent showing name,
      provider, today's cost, active groups, last activity
- [ ] `/agents/<id>` per-agent detail page consolidates the v1
      "Server health" + "Groups" + "Cost" views, scoped to one agent
- [ ] **Add Agent** action in `/agents` header opens a modal that
      re-uses the wizard's `ProviderStep` + `CredentialsStep` +
      a new persona/name capture step. Same components, different
      surface.
- [ ] Per-agent **Switch model** action (the existing model-switch
      modal from § 7.4, scoped to all of an agent's groups at once
      rather than per-group)
- [ ] Cost rollup: per-agent total = sum of `cost_micros` across that
      agent's groups; tree-aware view for future organogram support
      (parent agent's cost includes descendants, sub-agent rollup is
      a recursive SQL view that returns 0 today and the right answer
      when sub-agents exist)

### 9.5.5 Wizard — Add Agent flow (post-install)

- [ ] The first-run wizard still creates one default agent (no
      regression on first-time install UX)
- [ ] **Re-entering the wizard** (`NANOCLAW_FORCE_WIZARD=1` or
      "Re-run setup anyway" on the welcome screen) skips to the
      provider step if the operator wants to add another agent rather
      than reconfigure the existing one. The wizard surfaces:
      *"You have 1 agent (Andy). Add a second agent on a different
      provider, or reconfigure Andy?"*
- [ ] Adding an agent from the dashboard's `/agents` page bypasses
      the wizard's chrome but reuses the same React components for
      provider selection + credentials + persona

### 9.5.6 Phase H acceptance

- [ ] Existing v1/v2 operator upgrades — sees their setup unchanged,
      one default agent named whatever they originally set
- [ ] Operator adds a second agent (Ben on Gemini) via dashboard;
      Ben appears on the agents page; Ben has zero groups initially
- [ ] Operator assigns the "Hobby" group to Ben (via the group's
      detail page); next message in Hobby spawns Gemini container
- [ ] Operator sends `@Andy hi` in the Hobby group; Andy responds
      via Claude container (per-message trigger override)
- [ ] Operator sends `@Ben hi` in the Family group (which is assigned
      to Andy); Ben responds via Gemini container
- [ ] Operator switches Ben's provider from Gemini to OpenAI; all of
      Ben's groups now use OpenAI on next inbound message; Andy
      untouched
- [ ] Operator deletes Ben; Ben's groups reassign to the default
      agent (Andy); Ben's memory namespace is preserved on disk for
      30 days before garbage-collection (operator can restore in
      that window)

---

## 10. Risks + gotchas

### 10.1 Free-tier rate limits
Gemini's free tier is generous (1,500 RPD) but trivial to hit on
1-minute RPM. If an operator enables open-DM mode on a busy group,
they'll burn through 15 RPM in under a minute. The capability
banner in § 9.6 sets expectations; the rate-limit handling in
§ 9.7 prevents crashes.

### 10.2 Model deprecation
Google deprecates Gemini models on a roughly 18-month cadence
(e.g. `gemini-1.5-pro` is sunsetting in late 2026). The
`default_model` in providers.json needs an annual review. Operators
running an old DMG against a deprecated model will get clean error
messages from the container ("Model not found"); we surface this
in the dashboard's health card.

### 10.3 Gemini's OpenAI-compat endpoint quirks
The compat endpoint is in beta as of writing. Known issues:
- Streaming chunk format occasionally differs from OpenAI's exact
  shape (handle gracefully in the SDK wrapper)
- `tool_choice: "required"` semantics differ slightly
- Token usage counts in responses are rounded (rare 1–2 token
  discrepancies in `cost_micros` calculations — acceptable)

Re-validate before each release: send a tool-use call, verify the
SDK doesn't throw on the response shape.

### 10.4 Native Gemini features that don't surface
Code execution, grounding-with-search, native audio/video input —
none are available via the OpenAI-compat endpoint. If an operator
asks "why can't Gemini search Google for me here?" the answer is
"because we're using the OpenAI-compat layer. The native Gemini
API has it, but we'd need a separate `nanoclaw-agent-gemini-native`
container to expose it." Path is documented as a future escape
valve in the playbook's § 12 status table.

### 10.5 Auth-header format detail
Gemini's compat endpoint accepts BOTH `Authorization: Bearer <key>`
AND `x-goog-api-key: <key>` headers. We use `Authorization: Bearer`
in `providers.json` because it's the OpenAI-canonical form and
matches what other future providers (OpenAI itself, OpenRouter,
Together) use. Don't switch to `x-goog-api-key` — that would split
the auth path unnecessarily.

### 10.6 Container image pinning per group
The orchestrator spawns `nanoclaw-agent-oai:<version>` where version
defaults to the orchestrator's current `package.json` version. An
operator with a working group on `:1.4.2` who upgrades the
orchestrator to `:1.5.0` shouldn't automatically inherit a broken
build. **Pin per group when stability matters.** `container_config`
gains an optional `container_image_tag` field; absent → use current
default; present → use that tag. The dashboard's Group Config Editor
exposes this under "Advanced settings."

### 10.7 Explicitly deferred (not in scope for v1.2 — but flagged
so they're not surprises later)

- **Provider failover.** If Gemini is rate-limited, fall back to
  OpenAI for the next N seconds. Architecturally clean given the
  wire-protocol consolidation; deferred because it complicates the
  audit log and cost attribution. Spec when an operator asks.
- **Multi-key support.** Some operators want a "Gemini work" and a
  "Gemini personal" credential. OneCLI supports it natively (two
  secrets); the wizard / dashboard don't currently surface it.
- **Time-bounded experiments.** "Try this group on Gemini for 7
  days, then auto-revert." Operationally interesting but adds a
  scheduler concern.
- **Per-group cost ceilings independent of open-DM.** Today open-DM
  has a daily budget; a non-open-DM group doesn't. Cap should be
  provider-aware and group-aware regardless of open-DM.
- **Native Gemini features container** (`nanoclaw-agent-gemini-native`)
  for grounding-with-search, code execution, native audio/video.
  The playbook permits this; we ship it only when operator demand
  exceeds the OpenAI-compat tradeoff.

---

## 10.5 Forward-compatibility ledger

The Gemini PR series ships six commitments that future surfaces
depend on. Each one is near-zero cost to get right now; multi-week
to retrofit later.

| Commitment | Phase in this blueprint | Future surface that depends on it |
|---|---|---|
| `agents` table is the primary entity, FK from groups + sessions | Phase H.1 § 9.5.1 | Any second / Nth agent on a deployment; organogram view; per-agent cost rollup |
| `agents.parent_agent_id` is a nullable FK (always null today) | Phase H.1 § 9.5.1 | Sub-agent hierarchies; organogram tree rendering |
| `agents.memory_namespace` is path-shaped (`agents/<id>`) | Phase H.1 § 9.5.1 | Memory tree's filesystem layout mirrors the agent tree; sub-agents nest naturally |
| Container env carries `AGENT_ID`, `ASSISTANT_NAME`, `MEMORY_PATH` (and reserved `PARENT_AGENT_ID`) | Phase H.2 § 9.5.2 | Per-agent isolation in container layer; sub-agents inherit parent context when shipped |
| Container emits SSE event stream (`message_start` → `content_block_delta` → `tool_use_*` → `message_stop`) | Phase A acceptance § 3.7 | Embedded CLI chat (deferred); voice mode (far-future); any progressive-render surface |
| Orchestrator's `POST /api/agent/message` endpoint with optional `stream: true` + optional `agent_id` | Phase B routing § 4.2 | Sandboxed test in Phase E; future embedded chat; provider health card "Test →"; any direct agent invocation that isn't via WhatsApp |
| Session schema gains `kind ∈ {group, dashboard-cli, sandboxed-test}` + `agent_id` FK | Phase B + H.1 | `sandboxed-test` sessions in Phase E (immediate); `dashboard-cli` sessions for embedded chat (deferred); per-agent session isolation always |

Reviewer responsibility for PR 1 specifically: confirm that
**every existing v1/v2 install upgrades cleanly** — operators on
the Claude-only path see no behaviour change, but their data sits
on top of the new agent-first foundation. Verify by spinning up a
v1 install, running through the migration, and confirming both
the dashboard and a real WhatsApp message still work identically.

Reviewer responsibility for PR 2 specifically: confirm the
container's event-stream output is well-formed against
[`PROVIDER_PLAYBOOK.md § 4.5`](../PROVIDER_PLAYBOOK.md#45-streaming-event-protocol-forward-compatibility)
*even though the immediate surface (sandboxed test) renders only
text content*. Tool-use events have to fire correctly today so
when the embedded chat ships later, no provider container needs
re-touching.

---

## 11. References

- [Gemini OpenAI-compatibility docs](https://ai.google.dev/gemini-api/docs/openai)
- [Google AI Studio — API key management](https://aistudio.google.com/app/apikey)
- [Gemini pricing](https://ai.google.dev/pricing)
- [Gemini rate limits](https://ai.google.dev/gemini-api/docs/rate-limits)
- [`PROVIDER_PLAYBOOK.md`](../PROVIDER_PLAYBOOK.md) — the architectural contract this blueprint implements
- [`ui-ux-direction.md`](../ui-ux-direction.md) — design tokens for the new cards and forms
- [PicoClaw OpenAI adapter (Go)](https://github.com/sipeed/picoclaw/tree/main/pkg/adapter/openai) — tool-use loop reference shape

---

## 12. Milestone breakdown

Suggested PR cadence:

| PR | Scope | Reviewer focus |
|---|---|---|
| PR 1 | **Phase H.1 + H.2 — agent-first data model.** Schema migration (agents table, agent_id FK), orchestrator agent helpers, container env additions, provider-resolution chain | Migration safety (v1/v2 → v3), zero regression on Claude path, no breakage for existing operators |
| PR 2 | Phases A + B + C — `nanoclaw-agent-oai` container, container-runner routing on `wire_protocol`, OneCLI registry, providers.json | Container isolation, streaming SSE protocol correctness, no regression on Claude path |
| PR 3 | Phase D + H.5 — wizard refactor (ProviderStep + CredentialsStep + Welcome model-agnosticism copy + post-install "Add Agent" flow) | UX flow, copy review, migration test |
| PR 4 | Phase H.3 + H.4 + E.1 — trigger-based agent dispatch in `src/router.ts`, agents page becomes dashboard root, per-agent detail page | Multi-agent coexistence, per-message trigger override correctness, audit-log writes |
| PR 5 | Phase E.4 — ModelSwitchModal (three-screen switch journey + sandboxed test, scoped per-agent not per-group) | Capability-diff correctness, test-message sandboxing via streaming protocol, post-switch verification banner |
| PR 6 | Phase E.5 — error diagnosis page + inline error markers in chat history (scoped per-agent) | Error taxonomy coverage, recovery-action affordances, copy review |
| PR 7 | Phase F + G — operator doc + full acceptance test suite (including Phase H acceptance: add agent, switch agent's provider, delete agent, trigger override) | Acceptance test signoff, operator-doc review |

Seven PRs over ~4 weeks. The previous "five to six PRs over ~3 weeks"
estimate was wrong — it underweighted the agent-first data model
which is now the foundation everything else rests on.

After PR 1 ships, the foundation supports **any number of agents on
any wire-compatible provider**. After PR 2 ships, the
OpenAI-compatible container is built. After that point, every new
provider (OpenAI, OpenRouter, Together, Groq, Ollama, vLLM, etc.)
takes **~2 hours of effort** — data-only additions to
`providers.json` + a short operator-facing doc + a one-line entry
in the model-switch modal's "Available providers" zone. Every new
*agent* using one of those providers takes ~30 seconds from the
operator's dashboard.
