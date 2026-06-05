# Provider Playbook

Long-run architectural contract for adding new AI providers (OpenAI,
Google Gemini, Ollama-local, OpenRouter, vLLM, anything else) to
NanoClaw — without touching the existing Claude path.

> **When to read this:** every time you're about to add a new model
> provider, change the wizard's provider-picker, or modify the
> container-runner's image-selection logic. Read end-to-end on the
> first pass; reference [§ 9 Per-provider implementation checklist](#9-per-provider-implementation-checklist)
> on subsequent passes.

---

## 0. Taxonomy — Deployment → Agents → Groups

> **Read this section first, even if you skip the rest.** It defines
> what an "agent" is in NanoClaw and how the operator's mental model
> nests. Most of this playbook talks about providers; this section
> establishes that **agents own providers**, not the other way around.

```
Deployment      one per machine today; multi-machine federation deferred
└── Agents      named entities, each with persona + provider + memory + cost
    ├── Andy    provider: claude · persona · trigger @Andy
    │   ├── Group "Family"      ◄── inherits Andy's provider unless overridden
    │   └── Group "Work"
    ├── Ben     provider: gemini · persona · trigger @Ben
    │   └── Group "Hobby"
    └── Echo    provider: ollama-local · persona · trigger @Echo
        └── (no groups yet)
```

### What an Agent owns

| Attribute | Source | Why it's per-agent |
|---|---|---|
| `name` | Operator-chosen | Identity is what the operator manages |
| `persona` | Free-text system prompt + persona's `CLAUDE.md` template | Different agents can behave differently on the same machine |
| `provider` | One protocol + one model + one credential (from `providers.json`) | "Andy is on Claude" is a coherent statement; "this group is on Claude but that group is on Gemini" is harder to reason about |
| `memory_namespace` | Filesystem path: `groups/agents/<agent_id>/<group_folder>/` | Each agent has its own coherent memory tree; sub-agents (future) nest under their parent |
| `default_trigger` | `@<name>` derived from name (operator can override) | Multiple agents co-exist on one WhatsApp account by responding to distinct triggers |
| `parent_agent_id` | Nullable foreign key | Reserved for hierarchical agent trees (organogram) — see [§ 11](#11-long-run-architectural-commitments) |
| `health` | Rolled up from groups | Cost, error rate, rate-limit status, last successful call, etc. surface per agent in the dashboard |
| `cost_rollup` | Sum of `cost_micros` across the agent's groups | Operator sees "Andy cost $4.20 today" — a meaningful statement |

### What a Group owns (revised from current single-agent model)

| Attribute | Source |
|---|---|
| `jid` | WhatsApp group JID |
| `name` | WhatsApp group name |
| `agent_id` | Foreign key into `agents` — **NEW** |
| `folder` | Filesystem name under `groups/agents/<agent_id>/` |
| `container_config.provider` (optional override) | Today: per-group provider; with agents, this becomes a *rarely-used override* |

### The hierarchy resolves provider in this order

When a message arrives for a group, the orchestrator picks the provider by:

1. Group's `container_config.provider` (override, rarely set)
2. Group's `agent_id` → agent's provider (default path)
3. Deployment's `default_agent_id` → that agent's provider (fallback when group isn't yet assigned)

### Why agents and not "multiple deployments"

Two agents on one machine is much cheaper than two NanoClaw orchestrators
on one machine: one process, one HTTP port, one SQLite, one set of
launchd plists. The dashboard treats them as siblings of a single
deployment, which is what an operator looking at "my machine"
actually wants to see. Multi-deployment federation is a separate
concern handled by [VISION.md § Pillar 3](VISION.md) — relevant only
when agents live on different machines and need to coordinate.

---

## 1. Core principle — container per provider

NanoClaw spawns an agent container per chat group. The container runs
an *agent runtime* (today, Anthropic's Claude Agent SDK). The agent
runtime talks to one model provider. **We make the runtime swappable
at the container layer, not at a translation layer inside the
runtime.**

```
┌────────────────────────────────────┐
│       NanoClaw orchestrator        │   identical in every config
└─────────────┬──────────────────────┘
              │  per-group container_config.provider
              │
       ┌──────┴──────┬──────────────┬──────────────┐
       ▼             ▼              ▼              ▼
  ┌─────────┐  ┌──────────┐  ┌──────────┐  ┌────────────┐
  │ Claude  │  │  OpenAI  │  │  Gemini  │  │   Ollama   │
  │  Agent  │  │  Agents  │  │  Gen AI  │  │   local    │
  │   SDK   │  │   SDK    │  │   SDK    │  │   model    │
  └─────────┘  └──────────┘  └──────────┘  └────────────┘
   default      v1.1 image   v1.2 image    v1.3 image
   v1.0,        (not built)  (not built)   (not built)
   untouched
```

### What this buys

- **Claude path stays untouched.** Operators on the default Anthropic
  branch get the same code, the same SDK, the same tested behaviour.
  No translation-proxy degradation, no shared-runtime regression risk.
- **Provider work is parallelisable.** Adding OpenAI doesn't require
  any change inside the Claude container. The OpenAI container is a
  new image, built and tested independently. A broken Gemini
  container can't take down the Claude group.
- **Per-group choice is natural.** "Use Claude for the main group,
  Llama for the hobby group" is the default shape, not a special case.
- **Honest capability surface.** Each provider's capabilities are
  exactly what its native SDK supports — no silent feature degradation
  from a translation layer.

### What this is NOT

- It does **not** translate Anthropic's protocol to OpenAI's
  on-the-fly. We considered that ("Path A"). It's clever but lossy:
  Anthropic-specific features (prompt caching, computer use, certain
  tool-use patterns) silently degrade, and operators can't reason
  about quality.
- It does **not** rewrite the agent runtime in a universal-agent
  framework (LangChain, AI SDK, etc.). Each provider-container is
  free to use whichever native SDK gives the best agent quality on
  that provider.

### Container per wire protocol (2026-05-14 consolidation)

After a design pass, **one container per wire protocol** beats
**one container per provider** for every metric we cared about. Today
the consolidation is: `nanoclaw-agent` (Anthropic native) +
`nanoclaw-agent-oai` (OpenAI-compatible — backs OpenAI, OpenRouter,
Together, Groq, Gemini-via-compat, Ollama, vLLM, etc.). Each provider
is still a distinct row in `setup/providers.json` with its own
sign-up flow, default model, capability matrix, and operator copy —
but multiple rows map to the same image when they share a wire
protocol.

This collapses Phase A and Phase B of [§ 9](#9-per-provider-implementation-checklist)
to "one-time work" for the first provider in each wire-protocol
family. Subsequent providers in the same family are data-only
additions to `providers.json`.

When a provider's native features (Gemini's grounding-with-search,
hypothetical OpenAI-only future features) materially exceed what the
shared wire-protocol exposes, a provider can still get its own
native container — `nanoclaw-agent-gemini-native`, for example. The
playbook treats this as an escape valve, not the default. Default is
data-only additions.

Reference implementation of the consolidation: [`docs/implementation/gemini-blueprint.md`](implementation/gemini-blueprint.md)
— builds `nanoclaw-agent-oai` while shipping Gemini, then every
subsequent OpenAI-compatible provider is a `providers.json` entry
plus an operator-facing doc.

---

## 2. Reference inspiration — PicoClaw, in depth

We are not copying PicoClaw, but the user has stated a preference for
modelling on their patterns. Five specific ideas we've adopted:

### 2.1 `<protocol>/<model>` string identifiers

PicoClaw stores model references as one canonical string:
`anthropic/claude-opus-4.6`, `openai/gpt-5.4`, `ollama/llama3.3:70b`.
The protocol prefix tells you what to ask, the model tail tells you
which version. Operators read it once and understand the deployment.
**We adopt this verbatim** — same string surfaces in the wizard's
provider-picker, the dashboard's per-group chip, the orchestrator's
container env, and the OneCLI secret label.

### 2.2 Layered config — sensitive vs not

PicoClaw separates `config.json` (insensitive, in repo) from
`.security.yml` (sensitive, never in repo). API keys go in the latter.
**We adopt the spirit** — the wizard's `providers.json` registry
holds public defaults; per-installation credentials live in OneCLI's
encrypted vault on the local machine. Nothing sensitive crosses the
git boundary.

### 2.3 Local providers skip the credential step

PicoClaw's Ollama entries have no `api_key` field. The WebUI Launcher
hides the credential input when the provider's `auth_kind` is `none`.
**We adopt this** — the wizard's `credentials` step auto-advances
(with a 250 ms "detected Ollama running" toast) when the chosen
provider is local-only.

### 2.4 Provider registry as data, not code

PicoClaw's WebUI Launcher renders its provider picker from
`config/providers.json`. Adding a 31st provider doesn't require
writing 31 React components — it's a data change with one new entry.
**We adopt this** — the wizard's `ProviderStep` is data-driven from
`setup/providers.json`. Per-provider sub-components only exist for
credential-collection quirks (most providers reuse the standard
"paste API key" sub-component; OAuth-only providers like
GitHub Copilot get their own).

### 2.5 First-run rhythm — "Configure a Provider → Channel → Gateway → Chat"

PicoClaw's four-step rhythm is the proven onboarding cadence for
non-technical operators. **We adapt this** — NanoClaw has more steps
because we also handle the container build and WhatsApp pairing, but
the *provider* leg of the journey is one explicit choice followed by
one explicit credential entry — exactly two screens, no compound
forms.

### What we deliberately don't take from PicoClaw

- **Their model routing layer** (rule-based: simple queries → small
  model, complex → big model). Interesting; out of scope for v1.
- **Their 30-provider initial breadth.** We ship the four highest-
  leverage providers first (Anthropic, OpenAI, Gemini, Ollama) and
  add more only when an operator asks. Less surface, less drift.
- **Their hooks / steering / subturn primitives.** These are agent-
  loop-level features that live *inside* each provider container.
  Outside this playbook's scope — each provider's container README
  documents whatever its native SDK offers.

---

## 3. Wizard flow integration

The current wizard journey (13 steps, all Anthropic-implicit) becomes
a 14-step journey where one step splits into two **data-driven**
sub-steps. Read this before touching
`cli/claw-setup-gui/src/renderer/src/hooks/useWizard.ts` or its CLI
sibling.

### 3.1 Step ordering — before vs after

```
BEFORE                          AFTER
─────────────────────────       ─────────────────────────
welcome                         welcome
profile                         profile
envCheck                        envCheck
install                         install
onecli ◄── implicit Anthropic   provider     ◄── NEW
mounts                          credentials  ◄── replaces onecli; data-driven per provider
container                       mounts
whatsapp                        container
service                         whatsapp
register                        service
openmode                        register
smoke                           openmode
ready                           smoke
                                ready
```

**`onecli` is renamed `credentials`** because OneCLI is the credential-
injection layer for *every* provider that has cloud creds — not just
Anthropic. The screen contents adapt to whichever provider was chosen
one step earlier. For local providers (Ollama / vLLM) the credentials
step does nothing visible — it auto-advances after a 250 ms detection
probe. **Never gate a local provider on a credentials screen** —
operators who picked "free, runs locally" shouldn't see fields they
can't fill.

### 3.2 What lives where after the split

| Step | Job | Data source |
|---|---|---|
| `provider` (new) | One picker. Operator selects which AI provider answers this deployment's messages. | `setup/providers.json` registry; the wizard reads it and renders one card per entry, recommended-first. |
| `credentials` (replaces `onecli`) | Provider-specific: collect API key (Anthropic / OpenAI / Gemini), or auto-detect local endpoint (Ollama / vLLM), or open an external dashboard (some OAuth-only providers). | Selected provider's entry in `providers.json` + a per-provider React sub-component at `steps/credentials-<protocol>.tsx`. Most providers share the standard `credentials-apikey.tsx` sub-component. |

### 3.3 Resumable state — what the new steps write

Both wizards (GUI + CLI) update `~/.config/nanoclaw/setup-state.json`
with the operator's choices. After `provider` and `credentials`
complete, the state file looks like:

```jsonc
{
  "version": 2,
  "completedSteps": ["welcome", "profile", "envCheck", "install",
                     "provider", "credentials"],
  "provider_default": {
    "protocol": "anthropic",
    "model": "claude-opus-4.6",
    "base_url": null,
    "credential_id": "Anthropic"
  },
  // ...
}
```

The CLI wizard's `--resume` flag picks up at `mounts` from this
state without re-asking the provider question. Same contract the
existing wizard already honours — adding two steps doesn't break
resumability.

### 3.4 Dashboard's per-group override path

The wizard sets `provider_default`. The dashboard's Group Config
Editor lets the operator override on a per-group basis after install:

```
Group "Family group"      [Provider ▾] claude-opus-4.6  (default)
Group "Hobby experiments" [Provider ▾] llama3.3:70b     ← overridden
Group "Work assistant"    [Provider ▾] gpt-5.4          ← overridden
```

A group with no override inherits `provider_default`. Switching a
group's provider rebuilds *only that group's* container on the next
inbound message; existing groups continue running their current
container untouched. **Operators don't lose conversation state when
they switch** — the new container reads the same per-group SQLite
session and CLAUDE.md memory.

---

## 4. The four contracts every provider must satisfy

When you add a new provider, you're satisfying four contracts at four
layers. The [implementation checklist in § 9](#9-per-provider-implementation-checklist)
is structured around these.

### 4.1 Container contract

Every provider-container is a Docker image that:

| Property | Required value |
|---|---|
| Image name | `nanoclaw-agent-<protocol>` (e.g. `nanoclaw-agent-openai`) |
| Tag | Matches the orchestrator's `package.json` version |
| Image build script | `container/<protocol>/build.sh` |
| Entrypoint | Reads message JSON from `/workspace/in.json`; writes reply to `/workspace/out.json`; exits 0 on success, non-zero on failure |
| Env vars | `ASSISTANT_NAME` (persona), `MODEL` (the full `<protocol>/<model>` string), `ONECLI_GATEWAY` (default `http://host.docker.internal:10254`) for cloud providers; `PROVIDER_BASE_URL` (e.g. `http://host.docker.internal:11434/v1`) for local providers |
| Credential injection | Outbound HTTP calls go through the OneCLI gateway; OneCLI injects the provider's API key into the right header. Local providers skip OneCLI and call the local URL directly. |
| Logs | stdout/stderr; orchestrator captures and forwards to per-group log file |
| Mount allowlist | Identical to the Claude container — read from `~/.config/nanoclaw/mount-allowlist.json` |

**Concrete in/out shapes.** The orchestrator writes one JSON file
into the container's `/workspace/in.json` and waits for the container
to write `/workspace/out.json`:

```jsonc
// in.json — what the orchestrator writes
{
  "version": 1,
  "groupJid": "120363xxxxx@g.us",
  "groupName": "Family group",
  "messageText": "@Andy what's the weather in Cape Town?",
  "senderName": "Don",
  "history": [ /* last N messages, oldest first */ ],
  "assistantName": "Andy",
  "model": "anthropic/claude-opus-4.6",
  "tools": ["web_search", "filesystem", "kanban"]
}

// out.json — what the container writes back
{
  "version": 1,
  "replyText": "Currently 22 °C with light cloud …",
  "toolCalls": [ /* optional, for audit log */ ],
  "tokenUsage": { "input": 1834, "output": 412 },
  "model": "anthropic/claude-opus-4.6",     // echoes which model answered
  "cost_micros": 2730                       // cost in micro-USD, attributable to provider
}
```

`cost_micros` is what the dashboard's cost panel reads to attribute
spending per provider. Containers that can't compute it (Ollama,
self-hosted) write `0`.

**The default container (Claude) is the reference implementation.**
Read `container/build.sh` and `container/agent-runner/` to see what
a working provider-container looks like. New providers mirror that
structure — same `in.json`/`out.json` contract, same mount layout.

### 4.2 Wizard contract

Every provider must contribute a **wizard branch** that collects
exactly what OneCLI needs to inject credentials and what the
container needs to know about the model. The branch is implemented
in `cli/claw-setup-gui/src/renderer/src/steps/`:

| Element | What you provide |
|---|---|
| Display name + tagline | One line, plain English. See [§ 8 Operator-language guide](#8-operator-language-guide). |
| Capability matrix entry | See [§ 6 Capability matrix](#6-capability-matrix-operator-visible) — your row. |
| Credential form | Zero or more fields, labelled, validated, `password`-typed where appropriate. Most providers reuse `credentials-apikey.tsx`. |
| Pre-flight probe | Hits the provider's `/v1/models` (or equivalent) with the entered credentials before continuing. Surfaces "✓ Connected — found N models. Defaulting to <model>." |
| OneCLI secret config | The `host-pattern`, `header-name`, and `value-format` the wizard passes to `onecli secrets create`. Encoded in the provider's `providers.json` entry, not in the React component. |
| Model picker | Auto-populates from the provider's model-list endpoint where possible; falls back to a freeform input. **Always pre-select the recommended default.** |
| Default model | A sensible recommendation that gets pre-selected. |
| Subscription option (optional) | Providers that can also route through a consumer subscription declare a `subscription_auth` block in `providers.json` (`label`, `tagline`, `setup_command`, `token_format_hint`, `docs_note`, `supports_keychain_rotation`). When present, the credentials step renders an "API key vs subscription" choice; the subscription path collects a long-lived token from `setup_command` and validates it through the OneCLI proxy (`POST /v1/messages`), not the api-key `/v1/models` probe. Only Anthropic uses this today (`claude setup-token`). |

**UI pattern — the provider picker.** Layout the cards in a 2-column
grid (or 1-column on narrow viewports). Recommended provider sits
top-left with a subtle outline glow. Each card shows:

```
┌────────────────────────────────────────────┐
│ 🟧  Anthropic Claude            Recommended │
│                                              │
│ Strongest agentic quality. Cloud — needs an │
│ API key.                                     │
│                                              │
│ ✓ Best-in-class tools  ✓ Vision  ✓ Caching │
│ $$ ~$3/day for a chatty group                │
└────────────────────────────────────────────┘
```

Per-card "what you get / what you don't" needs to be glanceable in
under 5 seconds. Long-form trade-off text lives behind a "More about
this provider →" disclosure link below the card grid.

**UI pattern — the credentials step.** Single field, clear label,
visible help text *under* the field (not in a tooltip), pre-flight
button that says "Test connection" not "Submit." Successful test
auto-advances after 800 ms so operators don't have to click twice.

### 4.3 Dashboard contract

The dashboard is **agent-first**, not provider-first. The operator's
primary navigation answers "which of my agents am I looking at?"
Providers are a property of an agent; cost / health / errors roll up
per agent; the model-switching path is a per-agent journey.

#### 4.3.1 Primary navigation — Agents

| Element | What the dashboard shows | Why |
|---|---|---|
| **Agents page** (primary nav, replaces single-agent dashboard root) | One card per agent: name, current provider/model, today's cost, active groups, last activity, error count. The default agent is pinned first. | Agents are the operator's mental model. The dashboard reflects this from the top down. |
| **Add Agent action** | Opens a flow that re-uses the wizard's `ProviderStep` + `CredentialsStep` to spin up a new agent with a chosen provider. | Multi-agent-per-deployment is a first-class feature, not a config-file edit. |
| **Per-agent detail page** (`/agents/<id>`) | Health card v2, groups under this agent, persona editor, memory namespace size, recent activity, cost breakdown, "Switch provider" action. | Each agent gets its own coherent dashboard view. |
| **Organogram view** (deferred but data-ready) | Tree visualisation: deployment → agents → groups. Color-coded by provider, health, cost. Click any node to drill. | See [§ 11.1 Long-run architectural commitments](#11-long-run-architectural-commitments). |

#### 4.3.2 Agent-level controls

| Element | What it does | Why per-agent |
|---|---|---|
| Provider health card v2 | Active groups *for this agent*, today's spend vs cap (per-agent budget), rate-limit status, errors in 24h, current model | Provider health is a property of the agent using it, not the deployment as a whole |
| **Switch model** action (per-agent) | Three-screen flow: pick target → capability diff → optional sandboxed test → commit. All groups under this agent move together. | One coherent switch, not a per-group-N-times switch |
| Cost rollup | Per-agent total = sum of `cost_micros` across this agent's groups | "Andy cost $4.20 today" is a meaningful operator statement; provider-level rollup is a secondary view |
| Persona editor | Free-text persona description + agent's master `CLAUDE.md` | Differentiation between agents is what makes "multiple agents" useful |

#### 4.3.3 Per-group affordances (subordinate to agent)

| Element | What the dashboard shows | Why |
|---|---|---|
| Per-group chip on the agent's groups list | `<protocol>/<model>` (inherited from agent unless overridden) + a small "override" badge when set | Operator sees inheritance vs override at a glance |
| **Override provider for this group** (rare path) | Same modal flow as agent-level switch but scoped to one group. Hidden under Advanced settings. | The rare per-group override case still works without dominating the UI |

#### 4.3.4 Cross-cutting affordances

| Element | What the dashboard shows | Why |
|---|---|---|
| **Models page** (`/models`) | Two zones: configured providers and available-but-unused. Each card shows which agents are currently using it. Setting up a new provider from Zone 2 reuses the wizard's CredentialsStep. | Model-agnosticism remains a discoverable surface, alongside the agent-first nav |
| Capability-requirement re-evaluation | When an operator enables a feature (open-DM, vision, etc.), the dashboard checks every agent's provider and warns. | Capability mismatches happen per agent, not per group |
| Error diagnosis page | Per-error-class diagnosis + recovery action. Inline error markers in chat-history. Errors are scoped to an agent. | "Why did Andy stop responding?" is more actionable than "Why did group X stop responding?" |

Reference implementation of every element above: [`docs/implementation/gemini-blueprint.md § 7`](implementation/gemini-blueprint.md#7-phase-e--dashboard).

### 4.4 OneCLI contract

Every cloud provider gets its own OneCLI secret. Local providers
(Ollama, vLLM) get nothing — they don't need it. Naming convention:

```
<Provider-PascalCase>          # e.g. "OpenAI", "Gemini", "Ollama"
```

Secret config reference:

| Provider | `host-pattern` | `header-name` | `value-format` |
|---|---|---|---|
| Anthropic | `api.anthropic.com` | `x-api-key` | `{value}` |
| OpenAI | `api.openai.com` | `Authorization` | `Bearer {value}` |
| Gemini | `generativelanguage.googleapis.com` | `x-goog-api-key` | `{value}` |
| OpenRouter | `openrouter.ai` | `Authorization` | `Bearer {value}` |
| Groq | `api.groq.com` | `Authorization` | `Bearer {value}` |
| Together AI | `api.together.xyz` | `Authorization` | `Bearer {value}` |
| Ollama-local | (none — direct connection) | (none) | (none) |
| vLLM-local | (none — direct connection) | (none) | (none) |

Local providers' wizard branches record the base URL into the
group's `container_config.provider.base_url` instead of creating a
OneCLI secret.

### 4.5 Streaming event protocol (forward-compatibility)

The batch contract above (`in.json` → `out.json`) is the **default mode**.
Containers must additionally support a **streaming mode** so the
dashboard can surface progressive output for in-app chat, the
model-switch modal's sandboxed test, and any future surface that
needs token-by-token rendering. WhatsApp / Telegram channels stay
on batch because messaging platforms don't support streamed replies.

**Streaming transport.** When the orchestrator spawns a container in
stream mode, it sets `STREAM_MODE=sse` in the env and gives the
container a path to write events to (a Unix socket or a pipe). The
container emits Server-Sent-Events-shaped events; the orchestrator
forwards them to whichever caller is listening (HTTP client for the
dashboard, no-op for WhatsApp where it collects and writes a single
out.json at the end).

**Event taxonomy.** Every streaming container emits this event
sequence regardless of provider. Borrowed from Anthropic's streaming
shape because it's the most expressive of the three major formats;
OpenAI-compatible containers translate their provider's stream events
into this taxonomy:

```jsonc
// Event types in order
{ "type": "message_start", "messageId": "uuid", "model": "gemini/gemini-2.5-pro" }
{ "type": "content_block_delta", "delta": { "text": "Currently " } }
{ "type": "content_block_delta", "delta": { "text": "22 °C" } }
{ "type": "tool_use_start", "name": "web_search", "input": { "q": "weather Cape Town" } }
{ "type": "tool_use_result", "output": "..." }
{ "type": "content_block_delta", "delta": { "text": " with light cloud." } }
{ "type": "message_stop", "tokenUsage": { "input": 1834, "output": 412 }, "cost_micros": 2730 }
```

**Why this matters for Gemini.** The first surface that consumes the
stream protocol is the **model-switch modal's sandboxed-test screen**
(§ 7.4 of the Gemini blueprint). The operator clicks "Test" and sees
the reply render progressively rather than after a 4-second pause.
Building this protocol while we build the Gemini container is ~1 day
of work; retrofitting it after batch mode ships across multiple
provider containers is multi-day-per-container churn.

**Forward use cases this unlocks**, in order of likely adoption:

1. Sandboxed test in the model-switch modal (immediate — Gemini PR 4)
2. Provider health card's "Test →" action (immediate — Gemini PR 3)
3. Embedded CLI chat in the dashboard (deferred but unblocked — see [§ 12](#12-long-run-architectural-commitments))
4. Voice mode (much later — speech-to-text streams in, agent replies stream out)
5. Multi-agent debugging surfaces (e.g. "show me the agent's reasoning live")

### 4.6 Local-provider networking (Ollama, vLLM, anything-on-localhost)

The container needs to reach the operator's localhost Ollama daemon.
The networking trick differs per platform:

| Platform | URL inside container |
|---|---|
| Docker Desktop on macOS | `http://host.docker.internal:11434` |
| Docker Desktop on Windows | `http://host.docker.internal:11434` |
| Apple Container on macOS 15+ | `http://192.168.65.2:11434` (default host IP) |
| Linux (native Docker) | `--network host` then `http://127.0.0.1:11434` |
| Linux (Docker rootless) | `--add-host host.docker.internal:host-gateway` |

The orchestrator's `container-runner.ts` is responsible for picking
the right URL when it spawns a local-provider container. Provider-
container builders don't make this decision — the container just
reads `PROVIDER_BASE_URL` from env and trusts it.

**Pre-flight detection in the wizard.** Before letting the operator
pick the Ollama branch, the wizard probes `http://localhost:11434/api/tags`
from the wizard process (not the container). If it doesn't respond,
the picker shows a soft-blocking banner with "Install Ollama →"
linking to `https://ollama.com/download` — *don't* hide the option
entirely; operators sometimes want to install Ollama after seeing
it's available.

### 4.7 Path-resolution architecture (binary discovery is a contract, not a code-level fix)

NanoClaw runs as an Electron app launched from Finder *or* as a CLI
launched from the operator's shell. The two contexts inherit
fundamentally different `PATH` values, and the wizard / orchestrator
must discover the same binaries in both. This is a contract every
component that shells out (`docker`, `node`, `npm`, `tailscale`,
`ollama`, `onecli`) must satisfy.

**The Finder-launched-Electron PATH problem.** macOS Electron apps
inherit launchd's minimal PATH: `/usr/bin:/bin:/usr/sbin:/sbin`.
That excludes every modern developer-tool install location. The
operator's `which docker` succeeds from their shell; the wizard's
`spawn('docker', …)` fails with `ENOENT`. This is the single most
common "works on my machine" failure for non-technical operators —
they don't know `$PATH` exists, let alone that GUI apps inherit a
different one.

**Canonical binary discovery — `findBin(name)`.** Every component
that spawns a subprocess must go through this helper (today at
`cli/claw-setup-gui/src/main/services/path-utils.ts`; same pattern
must exist in `src/main/services/` of every desktop surface):

```typescript
// Resolution order, return the first that exists:
function findBin(name: string): string | null {
  return (
    // 1. App-bundle locations (where GUI apps install CLI siblings)
    checkAppBundle(name) ||           // /Applications/<App>.app/Contents/MacOS/<name>
                                       // /Applications/<App>.app/Contents/Resources/bin/<name>
    // 2. Version-manager shims (most recent first)
    checkVersionManagers(name) ||     // ~/.nvm/versions/node/*/bin/<name>
                                       // ~/.volta/bin/<name>
                                       // ~/.asdf/shims/<name>
                                       // ~/.fnm/aliases/default/bin/<name>
                                       // ~/.local/share/mise/shims/<name>
    // 3. Package-manager defaults
    checkPackageManagers(name) ||     // /opt/homebrew/bin/<name>      (Homebrew, Apple Silicon)
                                       // /usr/local/bin/<name>         (Homebrew Intel, npm-globals)
                                       // /opt/local/bin/<name>         (MacPorts)
    // 4. System defaults
    checkSystemPaths(name) ||         // /usr/bin/<name>, /bin/<name>
    // 5. The user's actual login-shell PATH (last resort)
    checkLoginShellPath(name)         // exec login shell, read PATH, search
  )
}
```

**Canonical environment for subprocesses — `envWithPath()`.** When
calling `spawn()` directly (instead of via `findBin` + absolute
path), apply this env override. Every subprocess utility in the
codebase (`runCommand`, `startRun`, container-runner spawn, etc.)
applies it by default:

```typescript
function envWithPath(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: [
      // App-bundle paths
      '/Applications/Tailscale.app/Contents/MacOS',
      '/Applications/Docker.app/Contents/Resources/bin',
      '/Applications/OrbStack.app/Contents/MacOS/xbin',
      // Version-manager shims
      `${process.env.HOME}/.nvm/versions/node/*/bin`,  // expanded via glob
      `${process.env.HOME}/.volta/bin`,
      `${process.env.HOME}/.asdf/shims`,
      `${process.env.HOME}/.fnm/aliases/default/bin`,
      `${process.env.HOME}/.local/share/mise/shims`,
      `${process.env.HOME}/.local/bin`,
      // Package-manager defaults
      '/opt/homebrew/bin', '/opt/homebrew/sbin',
      '/usr/local/bin', '/usr/local/sbin',
      '/opt/local/bin',
      // System defaults (always last)
      process.env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin'
    ].join(':')
  }
}
```

**Node-runtime discovery matrix.** Operators install Node a dozen
different ways. The wizard's env-check phase must succeed against
all of them without operator action:

| Install method | Binary location | Detection rule |
|---|---|---|
| Homebrew (Apple Silicon) | `/opt/homebrew/bin/node` | direct check |
| Homebrew (Intel) | `/usr/local/bin/node` | direct check |
| Official installer .pkg | `/usr/local/bin/node` | direct check |
| nvm | `~/.nvm/versions/node/<v>/bin/node` | glob + pick highest |
| Volta | `~/.volta/bin/node` (shim) | direct check |
| asdf | `~/.asdf/shims/node` | direct check + `asdf which node` |
| fnm | `~/.fnm/aliases/default/bin/node` | direct check |
| mise | `~/.local/share/mise/shims/node` | direct check |
| Corepack-only (no Node binary) | inside `package.json#packageManager` only | not supported — surface install banner |
| Snap (Linux) | `/snap/bin/node` | direct check |
| nix | `/nix/store/*/bin/node` or `~/.nix-profile/bin/node` | direct check |

**Version-conflict detection.** When `findBin('node')` finds multiple
candidates with different major versions, the wizard surfaces an
**operator-visible reconciliation step**:

> Found multiple Node versions on your machine:
>
> - 22.16.0 in /opt/homebrew/bin/node (Homebrew) — recommended
> - 18.19.0 in ~/.nvm/versions/node/v18.19.0/bin/node (nvm)
>
> NanoClaw will use 22.16.0. [Use a different one →]

Never silently pick. The "Just works on my friend's machine but not
mine" failure for a non-technical operator is almost always a
version mismatch the wizard didn't disclose.

**Docker runtime discovery matrix.** Same shape — operators install
Docker through one of five surfaces and the orchestrator must
discover them all:

| Install method | Binary location | Daemon socket | Localhost shape |
|---|---|---|---|
| Docker Desktop (macOS) | `/Applications/Docker.app/Contents/Resources/bin/docker` + `/usr/local/bin/docker` symlink | `~/.docker/run/docker.sock` | `host.docker.internal` |
| Docker Desktop (Windows) | `C:\Program Files\Docker\Docker\resources\bin\docker.exe` | named pipe `\\.\pipe\docker_engine` | `host.docker.internal` |
| Colima | `/opt/homebrew/bin/docker` + `colima` daemon | `~/.colima/default/docker.sock` | `host.docker.internal` (when started with `--mount-type=9p`) |
| OrbStack | `/Applications/OrbStack.app/Contents/MacOS/xbin/docker` + `/opt/homebrew/bin/docker` symlink | `~/.orbstack/run/docker.sock` | `host.docker.internal` |
| Apple Container (macOS 15+) | `/usr/local/bin/container` (or system path) | distinct CLI, *not* `docker`-compatible | `192.168.65.2` (default host IP) |
| Podman | `/opt/homebrew/bin/podman` | systemd socket | `host.containers.internal` |
| Linux native (rootful) | `/usr/bin/docker` | `/var/run/docker.sock` | `--network host` + `127.0.0.1` |
| Linux native (rootless) | `~/.local/bin/docker` | `${XDG_RUNTIME_DIR}/docker.sock` | `--add-host host.docker.internal:host-gateway` |

The orchestrator's container-runner identifies the runtime via
`docker info --format '{{.OperatingSystem}}'` (returns
`Docker Desktop`, `OrbStack`, `colima`, `Podman Engine`, etc.) and
uses that single string to pick the correct localhost-shape for
local-provider URLs in [§ 4.6](#46-local-provider-networking-ollama-vllm-anything-on-localhost).
Apple Container ships its own CLI named `container`, not `docker`;
when the orchestrator finds `container` but not `docker`, it
surfaces "Apple Container detected — supported but uses a different
CLI; please confirm" rather than failing or pretending to be Docker.

**Operator-visible "which binaries am I using" disclosure.** A
small expandable section on the env-check wizard step and on the
dashboard's settings page renders the resolved paths:

> ▾ Tools NanoClaw is using
>
> - Node 22.16.0 — /opt/homebrew/bin/node (Homebrew)
> - Docker 27.3.1 — /Applications/OrbStack.app/Contents/MacOS/xbin/docker (OrbStack)
> - OneCLI 0.4.2 — /usr/local/bin/onecli
> - Tailscale 1.74 — /Applications/Tailscale.app/Contents/MacOS/Tailscale
>
> Something here looks wrong? [Override paths →]

Non-technical operators ignore this section. Technical operators
debug network / version / sandbox issues without leaving the app.
Both win.

**The contract.** No new code in this repo shells out to a binary
by bare name. Every `spawn('foo', …)` call is `spawn(findBin('foo')
?? 'foo', …, { env: envWithPath() })`. Reviewers reject PRs that
add bare-name spawns. The "Tailscale shows not installed despite
running" bug is the canonical anti-pattern this contract prevents.

---

## 5. State + config schema additions

### 5.1 Setup-state (`~/.config/nanoclaw/setup-state.json`)

The setup-state now describes an **agent registry**, not a single
provider. Schema version bumps to 3:

```jsonc
{
  "version": 3,                            // bumped from 1 / 2
  "profile": "solo",
  "agents": [
    {
      "id": "andy",                         // stable slug, becomes the trigger word
      "name": "Andy",
      "persona": "Friendly, concise. Knows my preferences.",
      "provider": {
        "protocol": "anthropic",
        "model": "claude-opus-4.6",
        "base_url": null,
        "credential_id": "Anthropic"
      },
      "memory_namespace": "agents/andy",
      "default_trigger": "@Andy",
      "parent_agent_id": null,
      "is_default": true,
      "created_at": "2026-05-14T12:00:00Z"
    },
    {
      "id": "ben",
      "name": "Ben",
      "persona": "Creative, exploratory.",
      "provider": {
        "protocol": "gemini",
        "model": "gemini-2.5-pro",
        "base_url": null,
        "credential_id": "Gemini"
      },
      "memory_namespace": "agents/ben",
      "default_trigger": "@Ben",
      "parent_agent_id": null,
      "is_default": false,
      "created_at": "2026-05-21T09:30:00Z"
    }
  ],
  "default_agent_id": "andy",
  // legacy fields preserved for v1/v2 compat — derived from
  // `agents[is_default == true]` on read; written for older clients
  "assistantName": "Andy",
  "provider_default": { /* mirrors agents[0].provider */ }
}
```

Both wizards read/write this. Migration of existing v1 / v2 state is
described in [§ 10 Migration from Anthropic-only](#10-migration-from-anthropic-only).

### 5.2 Database schema (`store/messages.db`)

The orchestrator's existing SQLite gains an `agents` table and a
foreign key on `registered_groups`:

```sql
-- NEW
CREATE TABLE agents (
  id              TEXT PRIMARY KEY,                -- 'andy', 'ben', 'echo'
  name            TEXT NOT NULL,
  persona         TEXT,                            -- system prompt fragment
  provider_protocol TEXT NOT NULL,                 -- 'anthropic' | 'gemini' | ...
  provider_model    TEXT NOT NULL,                 -- 'claude-opus-4.6'
  provider_base_url TEXT,                          -- nullable; non-null for local
  credential_id     TEXT,                          -- OneCLI secret name; nullable
  memory_namespace  TEXT NOT NULL,                 -- 'agents/andy'
  default_trigger   TEXT NOT NULL,                 -- '@Andy'
  parent_agent_id   TEXT REFERENCES agents(id),    -- nullable; reserved for organogram
  is_default       INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL
);
CREATE INDEX agents_parent_idx ON agents(parent_agent_id);

-- MODIFIED
ALTER TABLE registered_groups ADD COLUMN agent_id TEXT REFERENCES agents(id);
CREATE INDEX registered_groups_agent_idx ON registered_groups(agent_id);

-- MODIFIED (already added by § 5.3 below for session_kind)
ALTER TABLE sessions ADD COLUMN agent_id TEXT REFERENCES agents(id);
```

**Resolution chain for "which provider answers this message":**

```
group.container_config.provider      ← rarely set
  ?? group.agent.provider             ← the default path
    ?? deployment.default_agent.provider  ← fallback when group has no agent
```

### 5.3 Per-group `container_config` (override layer)

A group's `container_config` JSON column in `store/messages.db`
already exists (used by open-DM mode). It can also carry a
**provider override** that wins over the agent's provider:

```jsonc
{
  "openMode": { "enabled": true, "dailyBudgetCents": 500 },
  "provider": {        // optional — present only when overriding the agent
    "protocol": "openai",
    "model": "gpt-5.4",
    "base_url": null,
    "credential_id": "OpenAI"
  }
}
```

**This is the rare path.** Most operators will leave this absent and
let groups inherit their agent's provider. The override exists for
edge cases like "Andy uses Claude in general, but this one group has
a hard cost cap and runs on Gemini-Flash for cheapness." Surface it
in the dashboard under Advanced settings, not as a primary action —
the primary path is per-agent provider, not per-group.

### 5.4 Session kinds (forward-compatibility)

The orchestrator's existing session model is per-WhatsApp-group:
one group has one session_id in SQLite, the agent reads / writes to
that session's memory. The plan introduces a `kind` field on the
session row to make non-group sessions a first-class concept rather
than a future migration:

```sql
ALTER TABLE sessions ADD COLUMN kind TEXT NOT NULL DEFAULT 'group';
-- kind ∈ {'group', 'dashboard-cli', 'sandboxed-test'}
--   group         — existing per-WhatsApp-group session
--   dashboard-cli — persistent in-dashboard chat (future)
--   sandboxed-test— ephemeral, no state mutation (used by model-switch modal)
```

The dashboard's sandboxed-test feature already uses
`kind = 'sandboxed-test'` rows — they're created at test time and
discarded after the test message exchange completes. The future
embedded-chat surface uses `kind = 'dashboard-cli'`. Adding the
column now means neither surface requires a schema migration when
it ships.

### 5.5 Provider registry (`setup/providers.json`)

A new file, committed to the repo at `setup/providers.json`,
describing each supported provider. The wizard and the dashboard
both read it. Adding a 9th provider is primarily a data change.

```jsonc
{
  "anthropic": {
    "name": "Anthropic Claude",
    "tagline": "Strongest agentic quality. Default recommended.",
    "auth_kind": "api-key",
    "default_model": "claude-opus-4.6",
    "models_endpoint": "https://api.anthropic.com/v1/models",
    "onecli": {
      "host_pattern": "api.anthropic.com",
      "header_name": "x-api-key",
      "value_format": "{value}"
    },
    "capabilities": {
      "tool_use": "best", "vision": true, "computer_use": true,
      "prompt_caching": true, "long_context": true, "local": false
    },
    "container_image": "nanoclaw-agent",
    "ships_in": "v1.0"
  },
  "openai": { /* ... */ },
  "ollama": {
    "name": "Ollama (local)",
    "tagline": "Free. Private. Runs on this machine.",
    "auth_kind": "none",
    "default_model": "llama3.3:70b",
    "models_endpoint": "http://localhost:11434/api/tags",
    "onecli": null,
    "capabilities": { /* ... */ },
    "container_image": "nanoclaw-agent-ollama",
    "ships_in": "v1.3"
  }
}
```

The wizard's provider picker renders one card per entry. The
dashboard's Group Config Editor populates its dropdown from the same
file.

---

## 6. Capability matrix (operator-visible)

Every provider's wizard branch shows this matrix before the user
commits. Non-negotiable — operators must not learn after-the-fact
that their chosen provider lacks computer-use or vision. Reference
matrix (kept in sync with each provider's entry in `providers.json`):

| Capability | Anthropic | OpenAI | Gemini | Ollama |
|---|---|---|---|---|
| Tool use | best-in-class | strong | strong | depends on model |
| Vision (image input) | ✓ | ✓ | ✓ | only with vision models |
| Computer use | ✓ | ✗ | partial | ✗ |
| Prompt caching | ✓ | ✓ | ✗ | n/a |
| Long context (≥200K) | ✓ | ✓ | ✓ | depends on model |
| Free / local | ✗ | ✗ | ✗ | ✓ |
| Agentic quality (subjective) | A+ | A | B+ | B− to C |

When the operator picks a provider that lacks a capability NanoClaw
uses elsewhere, **surface a banner** before they commit. Example:

> ⚠️ Open-DM mode uses prompt caching to keep cost low. The provider
> you picked doesn't support caching — expect ~3× higher token cost
> if you enable open-DM on this group.

---

## 7. Setup-ease principles

Apply at every wizard step that touches a provider decision. Tightened
from PicoClaw's four-step rhythm and stated as enforceable rules.

### 7.1 Cognitive-load rules

1. **One question per screen.** No multi-field forms unless the
   fields are conceptually one decision (URL + key + model count as
   one decision for a generic OpenAI-compatible provider).
2. **Default to recommended.** Pre-select Claude. Other providers are
   visible but not pre-checked. The "Other providers" affordance is
   secondary in the visual hierarchy.
3. **Detect, don't ask.** Ollama running locally? Auto-populate the
   model picker from `ollama list`. API key in clipboard from another
   app? Detect the prefix on paste and auto-fill if the format
   matches.
4. **No version pinning unless necessary.** Use the provider's
   "latest stable" alias (`gpt-5`, not `gpt-5.4-2026-03-01`) where
   one exists. Operators don't want to maintain version pins.

### 7.2 Confidence-building rules

5. **Test connection before continuing.** After collecting credentials,
   hit `/v1/models` and surface "✓ Connected — found N models.
   Defaulting to <model>." Auto-advance 800 ms later. Don't let an
   operator finish setup against a wrong key.
6. **Show the cost expectation.** If the provider publishes
   per-million-token prices, render a tiny "≈$X/day at your expected
   volume" estimate. Ollama shows "$0/day — runs locally."
7. **Show the capability trade-off before commit.** [§ 6](#6-capability-matrix-operator-visible)
   matrix appears in the provider card's expanded view *and* as a
   banner if the chosen provider lacks a feature the operator's
   downstream choices require (open-DM, vision, etc.).

### 7.3 Reversibility rules

8. **Provider switch is reversible.** Every group's provider can be
   changed from the dashboard. No data loss, no re-pairing — the
   new container just spawns on the next inbound message.
9. **Credentials never written to disk.** They live in OneCLI's vault
   throughout. The wizard never echoes them in logs or state files.
10. **No destructive defaults.** If the operator opens the wizard a
    second time, the provider question pre-selects what they chose
    last time. "Re-run setup" doesn't mean "start from scratch."

### 7.4 Failure-mode rules

11. **Pre-flight failures are diagnosed, not "try again."** If `/v1/models`
    returns 401, the message reads "That key didn't authenticate.
    Common causes: typo, key revoked, project deleted." Not "Error."
12. **Local-provider absence is install-able.** If the operator picks
    Ollama and the wizard's probe finds no Ollama daemon, the next
    screen is "Install Ollama →" with a one-click open-in-browser to
    ollama.com/download — *not* a hard rejection.
13. **Network errors are distinguished from auth errors.** Operators
    can fix the second; they often can't fix the first. The wizard's
    error copy says which.

### 7.5 Clean-machine bootstrapping rules

These rules are about the moment an operator runs the DMG on a Mac
where nothing AI-related has ever been installed. Apply at every
step the wizard takes before the operator's choices begin.

14. **The DMG carries Node.** Electron already ships a Node runtime;
    don't make the operator install one. The wizard runs *every*
    `npm` / `npx` / native script through the Electron Node, not
    through `findBin('node')`. The operator's host Node, if present,
    is informational only — used for the disclosure in § 4.7, not
    required for setup to succeed.
15. **One "fast path." Verbose path is opt-in.** The default install
    is a single primary button on the welcome screen: **Set up
    NanoClaw**. Behind it, the wizard executes every step that can be
    inferred (profile = solo, mounts = home directory, default
    provider = recommended) and only prompts when a credential or an
    operator-specific decision is unavoidable. Operators wanting to
    see every screen click **Custom setup** instead. The fast path is
    < 5 visible screens on a clean machine.
16. **Required external dependencies install themselves.** Docker
    (or whichever container runtime the operator picks), OneCLI, and
    Node-runtime (only when older than NanoClaw's minimum) are
    installed by the wizard via Homebrew on macOS / WinGet on
    Windows / the platform's package manager on Linux. The operator
    confirms once ("Install Docker now? — recommended"), never types
    a brew command. If the operator declines, the wizard surfaces
    the direct download link with no judgement.
17. **Probe first; if it works, don't ask.** Before showing any
    install prompt, the wizard probes for the dependency at every
    known location (§ 4.7 matrices). The "would you like me to
    install Docker" prompt fires only when *no* container runtime is
    found, not when Docker Desktop happens to be installed but its
    daemon isn't running. (When found but not running, the prompt is
    "Start Docker Desktop" with a one-click action.)
18. **One restart, at most.** Some installs require a logout/login
    (PATH refresh) or a reboot (WSL2). The wizard never requires
    *two*. If a step would chain into a second restart, the wizard
    refuses to start that step and surfaces "this needs a reboot
    first" before the operator commits.
19. **The wizard never crashes the way a shell would.** Every shell
    call has a fallback: if `brew install docker` fails because brew
    is missing, the next screen offers "Install Docker manually →
    download.docker.com/mac" with a clipboard-copy of the exact
    command if the operator wants to paste it themselves. The
    wizard's most-likely failure mode is "I tried and here's what
    happened," never a stack trace.

### 7.6 Apple-philosophy UX heuristics for swarm operators

NanoClaw is going to be operated by a non-technical user managing
multiple autonomous agents at once. The dashboard's job is to make
that legible without leaning on technical concepts. These heuristics
are non-negotiable for every surface that touches agents, groups, or
providers post-install.

20. **One primary action per screen.** Every page has exactly one
    button styled as the primary CTA (warm-orange fill). Secondary
    actions are ghost-styled. The operator never has to choose
    between two equally-emphasised options. The Agents page's
    primary CTA is **Add Agent**; the per-agent detail page's is
    **Send a test message**; the Models page's is **Set up this
    provider**. Anything that looks like a primary action but isn't
    one is a design bug.

21. **Status is rendered, not counted.** Don't show "3 errors in
    last 24h" unless the click is wired to an action. If the
    operator can't act on it, surface as a colour state
    (`● Reachable` / `● Degraded` / `● Offline`) and move the count
    into the detail view. Counts without actions are noise.

22. **Deferred disclosure for technical concerns.** Container image
    tags, OneCLI host patterns, model identifiers like
    `gemini/gemini-2.5-pro`, wire-protocol names — all hidden by
    default. Surface under an expandable "Technical details" section
    on detail pages. The Apple-products parallel: System Settings
    surfaces "Wi-Fi: connected"; "DHCP lease time" lives three taps
    deep behind a Details button.

23. **Names beat IDs everywhere user-facing.** The dashboard says
    "Andy" and "Family group," never `agent-andy-7f3a` or
    `120363xxxxx@g.us`. IDs live in tooltips on hover and in audit
    logs. New agents pick a name first, an `id` is derived by
    slugifying. Operators rename their agents in chat; the ID stays
    stable, the display name updates everywhere.

24. **Health rolls up; problems drill down.** The agents page shows
    each agent's single overall health dot. Clicking the dot expands
    to per-group health; per-group expands to per-call audit log.
    Never surface call-level detail at the deployment level. The
    only thing visible at the top is "are all my agents okay?"

25. **Direct manipulation over forms.** Switching a group's agent is
    a drag-and-drop from one agent's groups list to another's
    (mirroring the macOS Finder file move). The dropdown alternative
    exists for keyboard users. Renaming an agent happens in-place by
    clicking the name, not via a settings modal. Creating a new
    agent happens via a single + button in the corner of the Agents
    page, not via a multi-tab settings panel.

26. **Instant feedback for every action.** Every operator click
    surfaces visible feedback within 100 ms (loading spinner,
    skeleton state, or optimistic-update render). A click that does
    something silently — even if it succeeds — feels broken. The
    rule: if the action takes longer than 1 second, show a
    determinate progress indicator (not a spinner). If it takes
    longer than 10 seconds, surface a cancel affordance.

27. **Animations communicate state, not decorate.** Provider chips
    pulse subtly while the container is spawning. The model-switch
    modal's three screens slide left-to-right (matching the flow
    direction). Audio errors and successes get a tiny system-sound
    chime (off by default for operators who hate it, on by default
    for Apple-trained users who expect it). No animations exist
    purely for aesthetic — every one carries information.

28. **The dashboard fits on a 13" MacBook Air without scrolling on
    its primary views.** Agents page, Models page, per-agent detail
    page — all three lay out in a 1280×800 viewport without a
    vertical scrollbar appearing on initial paint. Operators
    looking at "everything my deployment is doing" see it on one
    screen, in one glance. Drill-downs and audit logs can scroll;
    summary pages cannot.

29. **Empty states teach.** First-time operator sees the Agents
    page with one card (Andy), the Models page with one Zone-1
    provider, the Errors page with a "Nothing's gone wrong — yet"
    illustration. Empty states explain what the page is *for*, not
    just that it's currently empty.

30. **Destructive actions are reversible by default.** Deleting an
    agent doesn't immediately remove the agent's memory. Instead,
    the agent is "archived" — invisible from the agents page,
    groups reassigned to the default agent, but the agent's
    `memory_namespace` directory and SQLite rows are preserved for
    30 days. A small "Recently archived (1) →" link on the Agents
    page lets the operator restore. Hard-delete is an explicit
    second action from the archive view, with a typed-confirmation
    pattern.

---

## 8. Operator-language guide

NanoClaw is for non-technical operators. The wizard and dashboard
copy lands plain. Refer to this when writing any provider-facing
text.

### 8.1 Word-pair substitutions

| Don't say | Say instead |
|---|---|
| "Tool use" | "Can use tools (search the web, read files, etc.)" |
| "Prompt caching" | "Cheaper after the first message in a conversation" |
| "Long context" | "Remembers more of the conversation" |
| "Token-cost attribution" | "How much each group costs you" |
| "Authenticate" | "Sign in" (or "Connect") |
| "Credential" | "API key" (concrete; operators know what one is) |
| "Pre-flight probe" | "Test connection" |
| "Hostpattern" | (don't surface — internal only) |
| "Container" | (don't surface unless debugging) |
| "Orchestrator" | "NanoClaw" |
| "OneCLI gateway" | "Credential vault" (in operator copy; OneCLI in dev docs) |
| "agentic quality" | (use "how well it follows complex instructions") |

### 8.2 Tone

- **Direct, not chatty.** "Open the dashboard," not "Click here to
  open your dashboard."
- **Specific, not vague.** "Took ~12 seconds," not "Just a moment …"
- **Optimistic about reversibility.** "You can switch providers any
  time from the dashboard."
- **Honest about cost.** Show the expected $/day before the operator
  commits.

### 8.3 Example — Claude provider card copy

> **Anthropic Claude — Recommended**
>
> The default. Strongest at tool use (calling search, reading files,
> writing files), cheapest per message after the first one in a
> conversation, can look at images you send.
>
> You'll need an Anthropic API key. Sign up at
> [console.anthropic.com](https://console.anthropic.com) if you
> don't have one — it's free to create an account; you pay per use.
>
> Expect roughly $2–4/day for a chatty WhatsApp group.

### 8.4 Example — Ollama provider card copy

> **Ollama — Free, runs on this Mac**
>
> No API key, no cloud, no per-message cost. Slower than Claude
> (model thinks for ~5–10 seconds before answering), and the quality
> depends on which model you pick. Best when you want privacy or
> you're experimenting.
>
> You'll need Ollama installed and one model pulled. The wizard
> will help.

---

## 9. Per-provider implementation checklist

Literal checklist to tick off in the PR description when shipping a
new provider.

### Phase A — Container

- [ ] `container/<protocol>/build.sh` — image build script producing
      `nanoclaw-agent-<protocol>:<version>`.
- [ ] `container/<protocol>/Dockerfile` — image definition. Base on
      the same minimal Linux as the Claude container.
- [ ] `container/<protocol>/agent-runner/` — agent loop using the
      provider's native SDK. Mirrors `container/agent-runner/` (the
      Claude version).
- [ ] Provider's native SDK pinned to a known-good version in the
      Dockerfile.
- [ ] Container reads `MODEL`, `ASSISTANT_NAME`, `ONECLI_GATEWAY`
      (or `PROVIDER_BASE_URL` for local) from env. Doesn't read raw
      credentials from env.
- [ ] Container honours the `in.json` / `out.json` contract from
      [§ 4.1](#41-container-contract) — including writing `cost_micros`.
- [ ] `container/<protocol>/README.md` — explains the SDK choice,
      provider-specific quirks, known limitations.

### Phase B — Orchestrator

- [ ] `src/container-runner.ts` — extend image-selection logic to
      read `group.container_config.provider.protocol` and spawn the
      matching container image. Default to `claude` when absent.
- [ ] `src/container-runner.ts` — handle local-provider networking
      per [§ 4.6](#46-local-provider-networking-ollama-vllm-anything-on-localhost).
- [ ] `src/types.ts` — add the `Provider` interface; update
      `ContainerConfig` to include the optional `provider` block.
- [ ] Tests — unit test per protocol's spawn path.

### Phase C — OneCLI

- [ ] `setup/providers.json` — add the new provider's entry
      (capability matrix, OneCLI secret config, default model,
      models endpoint).
- [ ] `setup/onecli-providers.ts` — registry helper that reads
      `providers.json` and calls `onecli secrets create` with the
      right flags.

### Phase D — Wizard (GUI + CLI)

- [ ] `cli/claw-setup-gui/src/renderer/src/steps/ProviderStep.tsx` —
      data-driven picker reading `providers.json`. Built once for
      v1.1; subsequent providers are data-only.
- [ ] `cli/claw-setup-gui/src/renderer/src/steps/credentials-<protocol>.tsx` —
      per-provider sub-step if the protocol has credential quirks
      (most reuse `credentials-apikey.tsx`).
- [ ] `cli/claw-setup/src/steps/03b-provider-<protocol>.ts` — CLI
      wizard mirror, `@clack/prompts`-based.
- [ ] Both surfaces share `provider_default` in setup-state.

### Phase E — Dashboard

- [ ] `dashboard/src/components/panels/cards/<Provider>Card.tsx` —
      health card mirroring `OneCLICard.tsx`'s shape.
- [ ] `dashboard/src/components/panels/GroupConfigEditor.tsx` — add
      a Provider dropdown populated from `providers.json`.
- [ ] `dashboard/src/components/panels/GroupListTable.tsx` — show
      the per-group provider chip.

### Phase F — Docs

- [ ] `docs/providers/<protocol>.md` — operator-facing guide:
      sign-up flow, expected cost, capability notes, model
      recommendations. Follows the [§ 8 operator-language guide](#8-operator-language-guide).
- [ ] Update [§ 13](#13-provider-implementation-status) status table
      in this file.
- [ ] `docs/CHANGE_LOG.md` entry for the provider's release.

### Phase G — Acceptance tests

- [ ] **Smoke test** — spawn the new container against a real
      credential, send `"What's 2+2?"` via the orchestrator, confirm
      `out.json` contains `"replyText": "4"` (or equivalent).
- [ ] **Tool-use test** — send a message that requires the agent to
      call a tool (e.g. `"What time is it in Cape Town?"` triggers a
      search). Confirm `toolCalls` populated.
- [ ] **Cost-attribution test** — dashboard's cost panel shows the
      right provider for the new container's calls, with non-zero
      `cost_micros` for cloud providers and `0` for local.
- [ ] **Provider-switch test** — change a group's provider in the
      dashboard, send a message, confirm new container spawns and
      the conversation continues against the new model.
- [ ] **Migration test** — if a v1 setup-state.json exists, verify
      [§ 10 migration](#10-migration-from-anthropic-only) applies and
      the dashboard shows the operator on Anthropic by default.
- [ ] **Capability-banner test** — if your provider lacks a
      capability another feature requires, confirm the wizard's
      banner fires before commit.
- [ ] **UX-copy review** — read every visible string against
      [§ 8 operator-language guide](#8-operator-language-guide).
      No "tool use," no "credential," no "orchestrator."

---

## 10. Migration from Anthropic-only

Existing operators run with `setup-state.json` schema v1 — no
`provider_default` field, no `agents` array, no per-group provider
override. The first wizard or orchestrator run after the multi-agent
work ships migrates them automatically. The rule is **one default
agent synthesised from the existing single-assistant setup**:

> If `setup-state.version < 3`, build the new state by:
>
> 1. Reading `assistantName` (defaults to `"Andy"` if absent).
> 2. Reading `provider_default` (or, on v1, falling back to
>    `{ protocol: "anthropic", model: "claude-opus-4.6" }`).
> 3. Creating one agent record:
>    ```jsonc
>    {
>      "id": slugify(assistantName),      // "andy"
>      "name": assistantName,             // "Andy"
>      "persona": "",                     // operator can fill later
>      "provider": <provider_default>,
>      "memory_namespace": "agents/" + slugify(assistantName),
>      "default_trigger": "@" + assistantName,
>      "parent_agent_id": null,
>      "is_default": true,
>      "created_at": <now>
>    }
>    ```
> 4. Writing the file as `version: 3` with `agents: [<the agent>]`
>    and `default_agent_id: <the agent's id>`. Keep the legacy
>    `assistantName` and `provider_default` fields synthesised from
>    the default agent so older clients reading the file still work.

**Database migration** runs once on orchestrator startup when it
detects the `agents` table is missing:

```sql
-- Create agents table (§ 5.2)
CREATE TABLE agents (...);
-- Insert the default agent synthesised from setup-state
INSERT INTO agents (id, name, provider_protocol, provider_model, ...)
  VALUES ('andy', 'Andy', 'anthropic', 'claude-opus-4.6', ...);
-- Add agent_id FK columns
ALTER TABLE registered_groups ADD COLUMN agent_id TEXT REFERENCES agents(id);
ALTER TABLE sessions ADD COLUMN agent_id TEXT REFERENCES agents(id);
-- Backfill all existing groups and sessions to point at the default agent
UPDATE registered_groups SET agent_id = 'andy' WHERE agent_id IS NULL;
UPDATE sessions SET agent_id = 'andy' WHERE agent_id IS NULL;
```

**Filesystem migration** is optional and lazy. Existing
`groups/<group_folder>/CLAUDE.md` files stay where they are. The
orchestrator reads them through a fallback chain:

```
groups/agents/<agent_id>/<group_folder>/CLAUDE.md   ← new layout
  ?? groups/<group_folder>/CLAUDE.md                 ← legacy fallback
```

When the operator creates a *second* agent, the dashboard offers a
one-click "move existing groups into Andy's namespace" action that
physically relocates the files. Until then, the fallback chain keeps
v1 installs working without any filesystem churn.

**Existing OneCLI secret** named `Anthropic` is exactly what the new
schema expects. Nothing to rename.

Net: a v1.0 operator upgrades, sees their existing setup unchanged
(one agent named whatever they originally set), and discovers they
now have an "Add Agent" affordance in the dashboard whenever they
want to spin up a second agent on a different provider.

---

## 11. Long-run architectural commitments

This section is for **forward-compatibility decisions** — choices we
make now because the cost of getting them right today is near-zero,
and the cost of retrofitting them later is multi-week-per-touched-
component. Add to this section whenever the team identifies a future
surface that depends on a contract being shaped a certain way today.

The section's rule: **don't build the future surface here.** Just
make sure the contracts we *are* shipping don't preclude it. Each
entry names the future surface, the architectural commitment that
keeps it possible, and where in this playbook the commitment is
operationalised.

### 11.1 Embedded CLI chat in the dashboard

**Future surface.** A terminal-style chat panel inside the Factotem
dashboard. The operator types a message, the agent for a chosen
group (or a generic agent) replies, tokens stream as they're
generated, tool calls render inline ("[Searching the web…] ✓"), the
session persists across dashboard reloads. Same WhatsApp persona,
no WhatsApp round-trip.

**Why this is forward-compatibility, not v1 scope.** Building the
terminal renderer is a meaningful frontend project (xterm.js or
equivalent, plus session management UI). The underlying I/O
contract is what we *do* commit to now, because three other v1
surfaces also need it: the model-switch modal's sandboxed test, the
provider health card's "Test →" action, and (when implemented) the
embedded chat itself.

**Architectural commitments operationalised today:**

| Commitment | Where it lives in this playbook |
|---|---|
| Container I/O contract supports both batch and streaming modes | [§ 4.1 Container contract](#41-container-contract) (batch baseline) + [§ 4.5 Streaming event protocol](#45-streaming-event-protocol-forward-compatibility) (stream supplement) |
| Orchestrator exposes `POST /api/agent/message` with optional `stream: true` | [§ 4.5 streaming protocol](#45-streaming-event-protocol-forward-compatibility) — the dashboard endpoint and the SSE event taxonomy are specified together |
| Sessions have a `kind` enum (`group`, `dashboard-cli`, `sandboxed-test`) | [§ 5.3 Session kinds](#53-session-kinds-forward-compatibility) — `dashboard-cli` is reserved as a legal value even though no surface uses it in v1 |
| Channel registry treats `dashboard-cli` as a planned channel type | The orchestrator's `src/channels/registry.ts` already supports multi-channel registration; `dashboard-cli` is added as a future-channel placeholder (no implementation) |
| Per-provider routing works for non-group sessions | [§ 4.1 Container contract](#41-container-contract) — containers read `MODEL` from env; the orchestrator decides which provider to spawn for any session, including dashboard-cli sessions |

**What's NOT committed today.** The terminal renderer (xterm.js vs.
plain monospace block), the session-history UI, the
authentication-of-dashboard-operator concern, the multiplexing of
multiple chat sessions, and whether `dashboard-cli` sessions share
or split the per-group memory. These are deliberate future-design
decisions. The contracts above don't prejudge them.

### 11.2 Agent organogram view

**Future surface.** A tree-visualisation page in the dashboard that
maps every agent on the deployment — root nodes are top-level agents,
children are sub-agents (when those exist), leaves are groups. Each
node carries colour-coding for provider, health, cost, and last
activity. Click any node to drill into its detail page. Filter the
tree by capability ("show me every agent that can do vision"), by
provider ("show me everything on Gemini"), or by health ("show me
errors in the last hour").

**Why this is forward-compatibility, not v1 scope.** Building the
tree renderer + interaction model + filter chips is a meaningful
frontend project. The underlying data model — agents nested via
`parent_agent_id` — is what we commit to today, because the cost of
adding that nullable column once is trivial vs. the cost of
re-modelling agents into a tree later.

**Architectural commitments operationalised today:**

| Commitment | Where it lives in this playbook |
|---|---|
| `agents` table has a nullable `parent_agent_id` FK | [§ 5.2 Database schema](#52-database-schema-storemessagesdb) — single nullable column, zero added complexity for v1 |
| Each agent has a stable `id` slug, not just a display name | [§ 5.2](#52-database-schema-storemessagesdb) — the `id` is what the tree links and filters operate on; renaming an agent's display name doesn't break the tree |
| `memory_namespace` is path-shaped (`agents/andy`, `agents/andy/research`) | [§ 0 Taxonomy](#0-taxonomy--deployment--agents--groups) — sub-agents nest under their parent's namespace by convention; the organogram's tree shape matches the filesystem's tree shape |
| Cost / health rolls up the tree | [§ 4.3.2 Agent-level controls](#432-agent-level-controls) — parent agent's cost = sum of own activity + sum of all descendants. Implemented as a recursive SQL view |
| Container env carries `AGENT_ID`, `PARENT_AGENT_ID` | When sub-agents ship, child containers know their parent. Today: `PARENT_AGENT_ID` is always empty; reserved for the future |

**What's NOT committed today.** Whether sub-agents can spawn each
other dynamically vs. only being created by the operator; whether
the tree is bounded in depth; whether sub-agents share their parent's
memory or have their own; whether sub-agent activity counts against
parent's cost budget. These stay open for future design.

### 11.3 Autonomous agent swarms (cluster of cooperating agents)

**Future surface.** An operator manages a *swarm* — five or fifty
agents on the same deployment, some delegating to others, some
specialised by role (research agent, writer agent, executor agent),
some triggered by automation rather than human chat. The dashboard
renders the swarm as a network graph; a primary agent (typically the
operator's default) routes work to specialised agents; audit logs
capture the full cross-agent chain for any single inbound message.

**Why this is forward-compatibility, not v1 scope.** The mechanics
of agent-to-agent dispatch — picking which sub-agent answers, how
context flows between them, cost attribution across the chain — is a
distinct project. The contract that keeps it possible is small:
agents must be able to address each other, and the dispatch path
must work whether the inbound trigger is a human (`@Andy`) or
another agent (an in-process call into the orchestrator's router).

**Architectural commitments operationalised today:**

| Commitment | Where it lives in this playbook |
|---|---|
| Orchestrator's router treats *every* inbound message as a `{trigger, payload, source}` triple, not as a WhatsApp-only event | [§ 4.3.4](#434-cross-cutting-affordances) — the router's input is channel-agnostic from day one. Agent-to-agent dispatch is just a new `source` kind. |
| `sessions.kind` includes a reserved value `agent-to-agent` even though no v1 surface emits it | [§ 5.4 Session kinds](#54-session-kinds-forward-compatibility) — the enum is extensible without schema migration |
| Audit-log entries carry an `originating_agent_id` separate from `responding_agent_id` | Both fields exist on every entry today; for human-triggered messages, `originating_agent_id` is null. Agent-to-agent chains populate both. |
| Cost attribution chains via `parent_session_id` | A sub-agent's session row links back to the session that dispatched it. The recursive cost view from [§ 11.2](#112-agent-organogram-view) already handles this shape. |
| Triggers are namespaced per-deployment, not per-channel | `@Andy` works in WhatsApp *and* from a sub-agent's tool call. The router resolves the trigger before considering the source channel. |
| Tool definitions can include `dispatch_to_agent(agent_id, message)` | A built-in tool every provider container can call. Today it's defined but rejects at runtime. When swarms ship, the orchestrator wires it up. |

**What's NOT committed today.** Whether sub-agents share their
parent's tool allowlist; whether agent-to-agent calls count against
the parent's budget cap; whether swarms have a depth limit; whether
specialised agents can be templated and shared across deployments.

### 11.4 Multi-deployment federation (cross-machine swarms)

**Future surface.** Two or more NanoClaw deployments — on different
Macs, on a home server, on a colleague's laptop — share state over
Tailscale or a similar mesh-VPN. An agent on machine A can dispatch
work to an agent on machine B. The operator sees a unified Agents
page that shows agents from every machine, grouped by deployment.

**Why this is forward-compatibility, not v1 scope.** Cross-machine
operation is genuinely hard (consistency, partition tolerance,
auth-between-machines, the same SQLite no longer being the source of
truth). v1 is single-machine only. The commitment is that v1's
schema and HTTP surface don't preclude federation in v2+.

**Architectural commitments operationalised today:**

| Commitment | Where it lives in this playbook |
|---|---|
| Every row in every NanoClaw-owned table carries a `deployment_id` (TEXT, UUIDv7 generated on first orchestrator start) | [§ 5.2 Database schema](#52-database-schema-storemessagesdb) — added to `agents`, `registered_groups`, `sessions`, `audit_log`. Single-machine v1 has all rows with one `deployment_id`; the column carries zero cost when there's one machine. |
| Orchestrator HTTP surface exposes `/api/deployment/info` (read-only) returning `deployment_id`, `host`, `agents`, `version` | Implemented in v1 for the dashboard's existing "what deployment am I on?" disclosure (§ 4.7 path-resolution panel). When federation ships, the same endpoint is what remote deployments query. |
| Agent IDs are namespaced as `<deployment_id>/<agent_id>` in *external* references; `<agent_id>` alone in *internal* references | Today the internal form is canonical; the external form is generated when an agent is referenced cross-deployment (federation only) |
| Tailscale presence is detected in the env-check phase | The wizard already checks for Tailscale ([cli/claw-setup-gui/src/main/services/env-checker.ts]); the result is informational in v1 and routing-enabling in v2 |

**What's NOT committed today.** The consensus mechanism for shared
state (single-leader vs CRDTs vs eventual-consistency-with-conflict-
resolution); the auth model between deployments (mTLS via Tailscale
ACL? operator-shared bearer tokens?); the dashboard's rendering of
multi-deployment agents (one merged view? per-deployment tabs?).
All deliberately deferred. v1's commitment is "the schema lets us
choose later without breaking v1 installs."

### 11.5 Future commitments

When a new long-run architectural concern surfaces, add it as a
sibling to § 11.1. Likely future entries:

- **Voice mode** — speech-to-text streams in, agent replies stream
   out via TTS. Commitments: same SSE protocol with
   `audio_delta` event type added; provider container honours
   audio-input message parts where the provider's API supports them.
- **Knowledge-base / RAG integration** — containers query a shared
   memory store before answering. Commitments: a tools-system entry
   for `retrieve_from_memory` that any provider's container can
   call.
- **Per-group persona splits** ("the same group, but the agent
   answers differently to weekend messages vs weekday") — multi-
   persona sessions. Commitments: persona is a per-session attribute,
   not just a per-group one.

The bar for adding a future commitment is *not* "we're going to
build this." It's: "if we don't make this contract decision now, the
future build will require changing every provider container / every
deployment / every session row."

---

## 12. Naming conventions (canonical)

| Thing | Convention | Example |
|---|---|---|
| Protocol identifier | lowercase, no punctuation | `anthropic`, `openai`, `gemini`, `ollama` |
| Model identifier | `<protocol>/<model>` | `openai/gpt-5.4`, `ollama/llama3.3:70b` |
| Container image name | `nanoclaw-agent-<protocol>` | `nanoclaw-agent-openai` |
| Container image tag | semver, matches orchestrator's `package.json` | `1.4.2` |
| OneCLI secret name | PascalCase provider | `OpenAI`, `Anthropic`, `Gemini` |
| Wizard sub-step component | `credentials-<protocol>.tsx` | `credentials-openai.tsx` |
| Dashboard card component | `<Provider>Card.tsx` | `OpenAICard.tsx` |
| Operator-facing doc | `docs/providers/<protocol>.md` | `docs/providers/openai.md` |
| Capability matrix column | display name | `Anthropic`, `OpenAI`, `Gemini`, `Ollama` |

Stick to these. Convention-over-configuration is what makes adding
the 8th provider as easy as the 4th.

---

## 13. Provider implementation status

Reference table. Update when a new provider ships.

| Protocol | Status | Container image | Doc | Notes |
|---|---|---|---|---|
| `anthropic` | ✅ Shipped (v1.0, default) | `nanoclaw-agent` (legacy name; the original) | [SETUP_WIZARD.md](SETUP_WIZARD.md) | Reference implementation. Don't touch. |
| `gemini` | ✅ Shipped (v1.2) | `nanoclaw-agent-oai` (shared OpenAI-compatible wire protocol) | [`docs/providers/gemini.md`](providers/gemini.md) | Free tier covers light personal use. Implementation guide: [`docs/implementation/gemini-blueprint.md`](implementation/gemini-blueprint.md). Acceptance suite: [`docs/implementation/gemini-acceptance.md`](implementation/gemini-acceptance.md). |
| `openai` | 📐 Registry-only (v1.3) | `nanoclaw-agent-oai` (shared) | `docs/providers/openai.md` (not written) | Add to `setup/providers.json` and write the operator doc — container is already built. ~2 hours of work per § 1 "Container per wire protocol." |
| `openrouter` | 📐 Registry-only (v1.3) | `nanoclaw-agent-oai` (shared) | `docs/providers/openrouter.md` (not written) | One key, many models. Same shape as `openai`. |
| `groq` | 📐 Registry-only (v1.3) | `nanoclaw-agent-oai` (shared) | `docs/providers/groq.md` (not written) | Fast inference. Same shape as `openai`. |
| `together` | 📐 Registry-only (v1.3) | `nanoclaw-agent-oai` (shared) | `docs/providers/together.md` (not written) | Wide model selection. Same shape as `openai`. |
| `ollama` | ⏳ Planned (v1.3) | `nanoclaw-agent-oai` (shared, with local base_url) | `docs/providers/ollama.md` (not written) | Local-only. Skip OneCLI entirely. First test of [§ 4.6 networking](#46-local-provider-networking-ollama-vllm-anything-on-localhost). |
| `vllm` | 🤔 Considered | `nanoclaw-agent-oai` (shared) | — | Self-hosted OpenAI-compatible. Probably `openai` shape with a custom `base_url` rather than its own protocol entry. |

---

## 14. What to do when this playbook is wrong

When you hit something this playbook doesn't cover — a provider with
multi-key auth, a SDK that requires a service-account file, a
provider that doesn't expose a `/v1/models` endpoint — **update this
file in the same PR** as the implementation. The playbook is living:
it stays useful only if every new provider implementation that
bumped into a gap closed that gap for the next person.

Don't fork the conventions silently. Either follow them, or update
them.

---

## 15. References

- [PicoClaw — providers table](https://github.com/sipeed/picoclaw#-providers-llm) — the 30-provider data-driven list NanoClaw is loosely modelled on.
- [PicoClaw — WebUI Launcher walkthrough](https://github.com/sipeed/picoclaw#-webui-launcher-recommended-for-desktop) — the "Configure a Provider → Channel → Gateway → Chat!" rhythm.
- [PicoClaw — Ollama configuration example](https://github.com/sipeed/picoclaw#-providers-llm) — the `model_list` shape we're adopting.
- [IronClaw — LLM_BACKEND env var pattern](https://github.com/nearai/ironclaw) — the OpenAI-compatible-everything fallback. We're not adopting this directly (containers per provider) but the env-var simplicity is the operator-facing target.
- [OneCLI secrets-create docs](https://onecli.dev) — per-provider `host-pattern` + `header-name` + `value-format` reference.
- [VISION.md § Pillar 1](VISION.md) — the LLM model agnosticism goal this playbook operationalises.
- [ui-ux-direction.md](ui-ux-direction.md) — wizard / dashboard design system the new provider UI must conform to.
- [SETUP_WIZARD.md](SETUP_WIZARD.md) — twelve-step setup journey both wizards walk.
- [`docs/implementation/gemini-blueprint.md`](implementation/gemini-blueprint.md) — reference implementation guide for the first non-Anthropic provider. Doubles as the build guide for the `nanoclaw-agent-oai` container that all subsequent OpenAI-compatible providers reuse.
