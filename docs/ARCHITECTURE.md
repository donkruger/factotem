# NanoClaw Architecture

Current-state architecture documentation. Last updated: 2026-05-08.

> This document describes "today". For where the project is going —
> multi-machine fleet orchestration over Tailscale, LLM model agnosticism,
> wizard-as-app-wrapper — see [VISION.md](VISION.md).

---

## System Overview

NanoClaw is a personal Claude assistant that runs as a single Node.js process. It bridges messaging channels to Claude Agent SDK running inside isolated Linux containers. Each registered chat group gets its own filesystem, conversation session, and memory.

```
┌─────────────────────────────────────────────────────────────┐
│                    HOST (macOS / Linux)                      │
│                   Single Node.js Process                     │
│                                                              │
│  ┌────────────┐  ┌────────────┐  ┌──────────┐              │
│  │  WhatsApp   │  │  Telegram   │  │  Slack   │  Channels   │
│  │  (Baileys)  │  │  (grammy)   │  │  (Bolt)  │             │
│  └──────┬──────┘  └──────┬──────┘  └────┬─────┘             │
│         │                │               │                   │
│         └────────────────┼───────────────┘                   │
│                          ▼                                   │
│              ┌──────────────────────┐                        │
│              │   Message Loop       │  SQLite (messages.db)  │
│              │   + Group Queue      │◄──────────────────────►│
│              │   + Task Scheduler   │                        │
│              │   + IPC Watcher      │                        │
│              └──────────┬───────────┘                        │
│                         │ spawns per message batch            │
│                         ▼                                    │
│  ┌──────────────────────────────────────────────────────┐   │
│  │              CONTAINER (Linux)                        │   │
│  │  Claude Agent SDK + MCP servers + Browser             │   │
│  │                                                       │   │
│  │  Voice: whisper.cpp transcription on host (no API)    │   │
│  │  Mounts: /workspace/group/ (RW), /workspace/extra/ .. │   │
│  │  Credentials: OneCLI gateway injection                │   │
│  └──────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

---

## Core Components

### 1. Orchestrator (`src/index.ts`)

The main event loop. Responsibilities:

- Receives messages from all channels via `onMessage` callbacks
- Stores messages in SQLite
- Checks trigger patterns and sender allowlists
- Enqueues message batches into the GroupQueue
- Spawns container agents and routes responses back to channels

### 2. Channel System (`src/channels/`)

Factory-based self-registration. Each channel implements the `Channel` interface:

```typescript
interface Channel {
  name: string;
  connect(): Promise<void>;
  sendMessage(jid: string, text: string): Promise<void>;
  isConnected(): boolean;
  ownsJid(jid: string): boolean;
  disconnect(): Promise<void>;
}
```

Channels register at import time via `registerChannel()`. The orchestrator iterates registered channels to find which one owns a given JID.

**Installed channels:**


| Channel  | Library                   | JID Format                             | Auth                   |
| -------- | ------------------------- | -------------------------------------- | ---------------------- |
| WhatsApp | `@whiskeysockets/baileys` | `phone@s.whatsapp.net`, `groupid@g.us` | QR code / pairing code |
| Telegram | `grammy`                  | `tg:{chatId}`                          | Bot token via OneCLI   |

**Voice transcription:** WhatsApp voice notes are automatically transcribed on the host using local `whisper.cpp` (via `ffmpeg` + `whisper-cli`). The pipeline converts OGG/Opus → 16kHz mono WAV → text, runs entirely on-device with no API cost. Transcripts are delivered to the agent as `[Voice: <text>]`. See `src/transcription.ts`.


### 3. Container Runner (`src/container-runner.ts`)

Spawns Docker containers for each agent invocation:

- Builds volume mounts (group folder, global memory, IPC, extra mounts)
- Validates additional mounts against the external allowlist
- Applies OneCLI credential injection config
- Streams stdin (prompt JSON) and reads stdout (output markers)
- Output delimited by `---NANOCLAW_OUTPUT_START---` / `---NANOCLAW_OUTPUT_END---`

**Container image:** `nanoclaw-agent:latest` (node:22-slim + Chromium + Claude Agent SDK)

**Default limits:**

- Timeout: 30 minutes (`CONTAINER_TIMEOUT`)
- Max output: 10MB (`CONTAINER_MAX_OUTPUT_SIZE`)
- Global concurrency: 5 containers (`MAX_CONCURRENT_CONTAINERS`)

### 4. Group Queue (`src/group-queue.ts`)

Per-group message queuing with global concurrency control:

- Each group has its own FIFO queue
- Global semaphore limits total active containers
- Retry logic with exponential backoff (base 5s, max 5 retries)
- Idle state tracking per group

### 5. IPC System (`src/ipc.ts`)

File-based inter-process communication between containers and the host:

```
data/ipc/{group}/
├── messages/    # Container → Host: send messages to other chats
├── tasks/       # Container → Host: create scheduled tasks
├── input/       # Host → Container: follow-up messages
│   └── _close   # Sentinel: signals session end
└── errors/      # Failed IPC files (debugging)
```

- Polled every 1 second (`IPC_POLL_INTERVAL`)
- Authorization: source group determined from directory path (not JSON)
- Non-main groups can only send to themselves
- Main group can send to any group

**Skill IPC extensions:** The `processTaskIpc` default case delegates to skill handlers (e.g. `src/skills/x-handler.ts` for `x_*` types). New integrations follow this pattern — MCP tools in the container write IPC task files, the host picks them up and runs skill-specific logic (browser automation, API calls, etc.), then writes results back to `data/ipc/{group}/x_results/` for the container to poll.

### 6. Task Scheduler (`src/task-scheduler.ts`)

Executes scheduled tasks (cron, interval, or one-time):

- Polls every 60 seconds for due tasks
- Tasks enqueued via GroupQueue (same concurrency control as messages)
- Context modes: `group` (persistent session) or `isolated` (single-shot)
- Next-run anchored to scheduled time to prevent drift

### 7. Mount Security (`src/mount-security.ts`)

Validates container mounts against an external allowlist:

- Allowlist path: `~/.config/nanoclaw/mount-allowlist.json` (outside project root)
- Resolves symlinks, expands `~`, checks blocked patterns
- Blocked patterns always enforced: `.ssh`, `.gnupg`, `.aws`, `.kube`, `.docker`, `.env`, `id_rsa`, `private_key`, etc.
- Non-main groups forced readonly when `nonMainReadOnly: true`

### 8. Database (`src/db.ts`)

SQLite via `better-sqlite3` at `store/messages.db`:


| Table               | Purpose                                                       |
| ------------------- | ------------------------------------------------------------- |
| `chats`             | Chat metadata (JID, name, channel, is_group)                  |
| `messages`          | Full message history for registered groups                    |
| `registered_groups` | Group config: JID, folder, trigger, container_config, is_main |
| `sessions`          | Group → Claude Agent session ID mapping                       |
| `scheduled_tasks`   | Task definitions (cron/interval/once)                         |
| `task_run_logs`     | Task execution history                                        |
| `router_state`      | Last-processed message timestamp per group                    |


### 9. Router (`src/router.ts`)

Message formatting and outbound routing:

- Inbound: wraps messages in XML with timezone context
- Outbound: strips `<internal>` tags, routes to correct channel via JID lookup
- Prefixes responses with assistant identity (configurable per channel)

---

## Message Flow

```
1. Channel receives message
   ↓
2. onMessage callback → storeMessage(db) → storeChatMetadata(db)
   ↓
3. Check: registered group? → trigger pattern match? → sender allowed?
   ↓
4. enqueueMessageCheck(groupQueue)
   ↓
5. processGroupMessages()
   ├── formatMessages(db.getMessagesSince(cursor), groupContext)
   │   → XML prompt with <context>, <group name/jid/is_main>, <messages>
   └── runContainerAgent(group, prompt, sessionId)
       ├── buildVolumeMounts() + validateAdditionalMounts()
       ├── buildContainerArgs() + applyOneCLIConfig()
       └── docker run -i --rm ... < stdin
           ↓
6. Container: Claude Agent SDK processes prompt
   ├── System prompt includes group identity (name, JID, routing rules)
   ├── Reads CLAUDE.md from /workspace/group/ and /workspace/extra/
   ├── Has access to MCP servers, browser, bash
   └── Writes output between markers to stdout
   ↓
7. Host parses output → stripInternalTags → routeOutbound
   ↓
8. Channel.sendMessage(jid, text)
```

---

## Security Model


| Layer            | Mechanism                                                |
| ---------------- | -------------------------------------------------------- |
| OS isolation     | Linux containers (Docker / Apple Container)              |
| Filesystem       | Only explicitly mounted paths visible to agent           |
| Mount validation | External allowlist + blocked patterns                    |
| Credentials      | OneCLI gateway injection (never in `.env` or containers) |
| IPC auth         | Source group from directory path (tamper-proof)          |
| Sender filtering | Per-chat allowlists (trigger/drop modes)                 |
| Agent profiles   | Profile-bound tool/permission/mount narrowing (`open_dm`) |
| Container user   | Non-root `node:1000`                                     |


---

## Agent Profiles

Each `RegisteredGroup` has an optional `agentProfile` field on its `containerConfig` that selects which **tool, permission, and mount surface** the spawned container gets. A profile is the unit of trust — flipping a group's profile changes what the agent can do without changing any other code.

| Profile | Used for | `permissionMode` | Tools | Mounts (additional) |
|---|---|---|---|---|
| `main` (`isMain=true`) | Operator's main group (e.g. GGA) | `bypassPermissions` | All including `Bash`, `Write`, `Task*`, `SendMessage` with cross-chat `target_jid` | Project root RO + group RW + everything in mount allowlist (Brain RW) |
| `standard` / unset (`isMain=false`) | Trusted registered groups (other group chats, manually-added DMs) | `bypassPermissions` | All except `mcp__nanoclaw__send_message`'s cross-group targeting and the explicit `disallowedTools` (currently just crons) | Group RW + global memory RO + per-group `additionalMounts` |
| `open_dm` | Auto-onboarded WhatsApp DM senders (`openMode`) | `default` (NOT bypass) | Narrowed: `Read`, `WebFetch`, `WebSearch`, `Glob`, `Grep`, `TodoWrite`, `mcp__nanoclaw__send_self`. Explicit `disallowedTools` enumerates the rest as defense-in-depth. | Group RW + per-group `additionalMounts` filtered to drop `brain`/`global` host-side. **Brain is absent from the filesystem**, not merely tool-gated. |

**Where profiles are enforced.**
- Tool / permission selection: `container/agent-runner/src/index.ts:507` branches on `containerInput.agentProfile`. The narrowed `allowedTools` for `open_dm` is the load-bearing tool gate.
- Mount filtering: `src/container-runner.ts:222-238` post-filters the `additionalMounts` allowlist when `agentProfile === 'open_dm'`. The host-side filter is the *primary* control for Brain isolation. The agent-runner tool gate is defense-in-depth.
- OneCLI agent identifier: `src/container-runner.ts:305-313` — `main` and `open_dm` reuse the default OneCLI agent (already authorised); `standard` non-main groups get per-folder agent identifiers (require operator dashboard grant).
- CLAUDE.md template copy: `src/index.ts` `registerGroup` skips the `groups/global/CLAUDE.md` template seed for `open_dm` so stranger sessions don't inherit operator-curated memory.

**Why `string` rather than booleans.** Forward-compatible. Adding `verified_resident` or `paying_user` profiles later is one new branch in each enforcement point, not a new combinator over existing booleans.

**Trust-boundary invariant.** A profile change must be the only thing required to flip the trust level for a group. Anything that cares about trust reads `agentProfile`; nothing reads ad-hoc combinations of `isMain` + folder name + flags. This is what makes "open to anyone" tractable as a single operational toggle.

See `OPERATIONS.md` § "Open DM Mode" for the operator runbook on enabling, disabling, and monitoring `open_dm`.

### `ContainerConfig` field reference

Per-group settings live in the `container_config` JSON column on `registered_groups` and deserialise into `ContainerConfig` (see `nanoclaw/src/types.ts` for the canonical definition). All fields are optional. Operators set them via SQLite `UPDATE` + restart (`launchctl kickstart -k`).

| Field | Type | Purpose | Notes |
|---|---|---|---|
| `additionalMounts` | `AdditionalMount[]` | Extra host paths to mount into the container | Validated against `~/.config/nanoclaw/mount-allowlist.json`. For `agentProfile === 'open_dm'`, host-side filter strips entries whose `containerPath` is in `{'brain', 'global'}`. |
| `timeout` | `number` (ms) | Override the container's hard timeout | Default 30 min via `CONTAINER_TIMEOUT`. Real timeout is `max(this, IDLE_TIMEOUT + 30s)`. |
| `agentProfile` | `'main' \| 'standard' \| 'open_dm'` | Selects the trust profile | See "Agent Profiles" section above. `'main'` derived from `is_main = 1`; `'open_dm'` set by `evaluateOpenMode` on auto-onboarding; otherwise unset (= `'standard'`). |
| `model` | `string` | Per-group SDK model override | Phase 0 of T-1777809840000. Resolution: this → `process.env.ANTHROPIC_MODEL` → `'claude-sonnet-4-6'` hardcoded. See `OPERATIONS.md` § "Per-Group Model Override". |
| `openMode` | `OpenModeConfig` | Deployment-policy: enable open_dm auto-onboarding | Lives **only** on the main group (`is_main = 1`); ignored elsewhere. Fields: `enabled`, `agentProfile`, `rateLimit`, `dailyBudgetCents` (required when enabled), `estCostCentsPerInvocation`. See `OPERATIONS.md` § "Open DM Mode". |

**Adding a new field:** the `container_config` JSON column accepts arbitrary keys with no schema migration. Define the field in `ContainerConfig` (`src/types.ts`), thread it through `ContainerInput` in `src/container-runner.ts` if the agent-runner needs to see it, and update this table. Three of the five existing fields landed today via this pattern (`agentProfile`, `openMode`, `model`).

---

## Memory System


| Scope            | Location                            | Access                                                            |
| ---------------- | ----------------------------------- | ----------------------------------------------------------------- |
| Per-group memory | `groups/{name}/CLAUDE.md`           | Read-write by group's container; **not seeded for `open_dm`**     |
| Global memory    | `groups/global/CLAUDE.md`           | Read-only for non-main groups; **mount skipped for `open_dm`**    |
| Agent SDK memory | `data/sessions/{group}/.claude/`    | Auto-managed by Claude Agent SDK                                  |
| External mounts  | `data/ipc/{group}/` validated paths | Per allowlist rules; **`brain`/`global` containerPaths stripped for `open_dm` host-side** |

**`open_dm` exclusions** are enforced at three points: `registerGroup` skips the CLAUDE.md template seed, `buildVolumeMounts` skips the `/workspace/global` mount, and the `additionalMounts` post-filter strips `brain`/`global` containerPaths. The `Read` tool is in the open_dm allow-list so the agent can read its own group folder, but everything operator-curated is absent from the filesystem entirely — not merely tool-gated.


---

## Configuration (`src/config.ts`)


| Setting                     | Default                  | Description                      |
| --------------------------- | ------------------------ | -------------------------------- |
| `ASSISTANT_NAME`            | `Andy`                   | Trigger name and response prefix |
| `TRIGGER_PATTERN`           | `(?:^                    | \s)@{name}\b`                    |
| `TIMEZONE`                  | Auto-detected            | IANA timezone for timestamps     |
| `CONTAINER_IMAGE`           | `nanoclaw-agent:latest`  | Docker image for agents          |
| `CONTAINER_TIMEOUT`         | 30 min                   | Max container runtime            |
| `MAX_CONCURRENT_CONTAINERS` | 5                        | Global concurrency limit         |
| `POLL_INTERVAL`             | 2s                       | Message check frequency          |
| `SCHEDULER_POLL_INTERVAL`   | 60s                      | Task check frequency             |
| `IPC_POLL_INTERVAL`         | 1s                       | IPC file check frequency         |
| `ONECLI_URL`                | `http://localhost:10254` | Credential gateway               |


---

## Dependencies

**Host (orchestrator):**

- `@whiskeysockets/baileys` — WhatsApp Web reverse-engineered client
- `grammy` — Telegram Bot API
- `better-sqlite3` — Synchronous SQLite
- `@onecli-sh/sdk` — Credential injection
- `pino` — Structured logging
- `cron-parser` — Cron expression parsing
- `zod` — Schema validation

**Container (agent-runner):**

- `@anthropic-ai/claude-agent-sdk` — Claude Agent execution
- `@modelcontextprotocol/sdk` — MCP server protocol
- Chromium — Browser automation via `agent-browser`

---

## Factotem: Fork Identity

This project is **Factotem** — operator-facing brand for the AI infrastructure built on the NanoClaw orchestrator primitive (fork: `donkruger/factotem`, originally forked as `donkruger/benclaw`). The upstream NanoClaw provides the messaging infrastructure and container isolation. Factotem adds a persistent cognitive layer, an operator dashboard, the Tauri Doctor menu-bar app, and the claw-setup cold-start wizard on top. **Ben** is the specific deployment of Factotem running on Don's machine (`@Ben` trigger word, WhatsApp number 27752007263).

| Setting | Value |
|---------|-------|
| Assistant name | Ben (trigger: `@Ben`) |
| Channel | WhatsApp → GGA group |
| Response prefix | `👱🏻‍♂️Ben here...` + blank line + message |
| Timezone | Africa/Johannesburg |
| Container runtime | Docker Desktop |
| Credentials | OneCLI gateway (Claude subscription token) |

---

## The Brain: Kanban Pro Data Layer

The Brain is the central architectural layer of BenClaw. It is what makes Ben a persistent, stateful agent rather than a stateless chatbot. Everything Ben knows, every task he tracks, and every standing instruction he follows lives here.

### What the Brain is

The Brain is a directory on the host filesystem that is mounted read-write into Ben's container at `/workspace/extra/brain/`. Its data layer is powered by **Kanban Pro** (KP) — a separate application that provides:

- A **visual Kanban board** to view and manage all tickets from a UI
- A **file-based data model** where every ticket is a standalone Markdown file with YAML frontmatter
- **Auto-generated indexes** (`MAPPING.md`) for token-efficient board overview
- **Agent-compatible conventions** (documented in the Brain's own `CLAUDE.md`) so AI agents can read and write tickets directly

The Brain path is configured as a mount in the group's `container_config` and validated against the external mount allowlist. The path itself may change over time — what matters is that the mount points to a Kanban Pro project directory.

### Why the Brain matters

Without the Brain, Ben has no memory between conversations. The Claude Agent SDK provides session continuity within a single container run, but each new message batch starts a fresh container. The Brain gives Ben:

1. **Persistent identity** — Core Mandates define who Ben is and how he behaves
2. **Long-term memory** — Facts, preferences, and context survive across every conversation
3. **Task management** — Work items move through a lifecycle (backlog → doing → done)
4. **Accountability** — Every task and memory is a visible, auditable ticket
5. **Visual oversight** — The owner can open Kanban Pro to see everything Ben knows and is working on

### Board structure

The Kanban board is organized into columns that serve distinct purposes:

| Column | ID | Purpose | Lifecycle |
|--------|----|---------|-----------|
| **Core Mandates** | `col_mandates` | Standing instructions that shape every response. Rules, preferences, recurring responsibilities. | Permanent — never archived unless explicitly revoked |
| **Persistent Memory** | `col_memory` | Facts, context, and knowledge. People's names, project details, decisions made. Not tasks — just things to know. | Long-lived — updated as knowledge evolves |
| **Backlog** | `col_backlog` | Tasks acknowledged but not yet prioritized. | Moves to To Do when ready |
| **To Do** | `col_todo` | Tasks queued for next action. | Moves to In Progress when started |
| **In Progress** | `col_doing` | Tasks Ben is actively working on. | Moves to Done when completed |
| **Done** | `col_done` | Completed tasks kept for reference and audit. | Moves to Archived when no longer relevant |
| **Archived** | `col_archived` | Historical items. Not loaded into active context. | Terminal state |

### Ticket format

Each ticket is a Markdown file in `tickets/` with strict YAML frontmatter (enforced by Kanban Pro conventions):

```yaml
---
id: "T-1774446799932"
title: "Short descriptive title"
status: "col_todo"
rank: "a0"
created: "2026-03-25T13:53:19.932Z"
type: "task"
priority: "none"
assignee: ""
tags: []
---

Description, context, acceptance criteria.
```

Filename must match `id`. Ticket types: `task`, `bug`, `feature`, `story`, `spike`. Priorities: `none`, `low`, `medium`, `high`, `critical`. Full conventions are in the Brain's own `CLAUDE.md` (auto-generated by Kanban Pro).

### How Ben uses the Brain

Ben's `groups/global/CLAUDE.md` contains a **brain-first operating mandate**:

1. **Every conversation starts** by reading `MAPPING.md` to load current state
2. **Core Mandates are always read first** — they shape every response
3. **New tasks** → create a ticket (Backlog or To Do)
4. **"Remember this"** → create a ticket in Persistent Memory (`col_memory`)
5. **Standing instructions** ("always do X", "never do Y") → Core Mandates (`col_mandates`, priority `critical`)
6. **Completing work** → update ticket status to Done (`col_done`)

### Data flow

```
┌──────────────────────┐     ┌─────────────────────────────────┐
│   Kanban Pro (UI)    │     │   BenClaw Container             │
│                      │     │                                  │
│  Visual board view   │◄───►│  /workspace/extra/brain/         │
│  Drag-and-drop       │     │   ├── MAPPING.md  (read first)  │
│  Create/edit tickets │     │   ├── tickets/*.md (read/write)  │
│  Sprint planning     │     │   ├── .kanban/board.json         │
│  Gantt charts        │     │   └── CLAUDE.md   (conventions)  │
│                      │     │                                  │
└──────────────────────┘     └─────────────────────────────────┘
         │                                    │
         └────────────────┬───────────────────┘
                          │
              Shared filesystem (host)
              Both read/write the same files
```

The owner can manage tickets from Kanban Pro's visual interface, and Ben can manage them from the container. Both operate on the same Markdown files. Kanban Pro auto-regenerates `MAPPING.md` on every UI change; Ben regenerates it after direct file modifications.

### Mount configuration

The Brain mount is configured in two places:

1. **Group's `container_config`** in SQLite (`registered_groups` table):
   ```json
   {
     "additionalMounts": [{
       "hostPath": "/path/to/brain/directory",
       "containerPath": "brain",
       "readonly": false
     }]
   }
   ```

2. **External mount allowlist** at `~/.config/nanoclaw/mount-allowlist.json`:
   ```json
   {
     "allowedRoots": [{
       "path": "/path/to/brain/directory",
       "allowReadWrite": true,
       "description": "Ben's brain - task and memory hub"
     }]
   }
   ```

The `containerPath` is relative — the mount system automatically prefixes it to `/workspace/extra/brain/`. The allowlist must explicitly grant `allowReadWrite: true` for the agent to modify tickets.

---

## v0.1.7 / v0.1.8 additions

The following surfaces landed alongside the dashboard v1 epic and the Doctor
v0.1.7-v0.1.8 releases. They're additive to everything above — no replacement
of existing primitives.

### `GET /api/persona` (v0.1.7)

Read-only snapshot of the deployment's assistant identity. Surfaces the global
`ASSISTANT_NAME` (read from `.env` via `src/config.ts`) and per-group
`trigger_pattern` (read from the live `registeredGroups` map). Mutations stay
on the existing `PATCH /api/groups/:jid` (per-group trigger) and operator-side
`.env` edit (global name) — there is no mutating persona endpoint in v1.

Response shape:

```json
{
  "assistant_name": "Sarah",
  "default_trigger": "@Sarah",
  "groups": [
    { "jid": "120363…@g.us", "name": "Mason Web Dev", "folder": "main",
      "trigger": "@Sarah", "is_main": true }
  ]
}
```

Implementation: [`src/http/api.ts`](../src/http/api.ts) `app.get('/api/persona', …)`.

### `/persona` dashboard route (v0.1.7)

Polls `/api/persona` every 10s. Renders global persona + per-group trigger
table + copy-pasteable change instructions (`.env` line + `setup --step
register` command). No mutating UI in v1 — operators edit `.env` and
re-register on the host. Source: [`dashboard/src/app/persona/`](../dashboard/src/app/persona/).

### `/health` probe upgrades (v0.1.7)

- `nanoclaw.version` is now read from `package.json` at module load
  (previously a never-set env var; always `"unknown"`). Override via
  `NANOCLAW_VERSION` for CI use.
- `probeOpenDm` actually probes the main group's `container_config.openMode`
  via the existing readonly SQLite connection — replaces the v1 stub that
  returned hard-coded `enabled: false`. Joins with `open_spend_log` for
  today's UTC-date spend total. Fail-soft: every error path degrades to the
  original placeholder shape, harmless for the dashboard.

### Doctor "Pull upstream updates…" (v0.1.8)

New tray-menu action between **Repair Stack…** and **Show diagnostic
details**. Opens a window at `?view=pull` rendering an 11-step manifest:
4 preflight (working tree clean, on `main`, fetched, no local-only commits
ahead of `origin/main`) + 7 mutating (pull, install + build orchestrator,
install + build dashboard, `launchctl kickstart`, verify `/health`).

Customised forks stay safe: any preflight failure stops the chain before any
mutation, with the human-readable reason rendered in the step's detail card.

Architecturally: shares the `repair.rs` step-chain runner. The `run_repair`
function is now a thin wrapper around `run_steps_chain(app, manifest,
event_channel)`; Repair uses the `repair-progress` channel and Pull uses
`pull-progress`. Source: [`cli/claw-doctor/src-tauri/src/pull.rs`](../cli/claw-doctor/src-tauri/src/pull.rs)
and [`cli/claw-doctor/src/views/PullView.tsx`](../cli/claw-doctor/src/views/PullView.tsx).

### WhatsApp `connect()` resolve fix (`bb632ed`)

Latent reliability bug fixed: `scheduleReconnect()` previously didn't forward
the `onFirstOpen` callback to retry attempts, so when Baileys closed-then-
reopened during signal-session resync (which happens routinely after a
SIGKILL restart), the original `connect()` Promise never resolved. `main()`
hung at `await channel.connect()`, never reached `queue.setProcessMessagesFn`
or `startHttpServer`. The fix threads `onFirstOpen` through the retry path so
any successful 'open' event resolves the Promise, regardless of which attempt
fires it. Full operator-side incident write-up lives in Don's `ben-log/`
journal (outside this repo) under `2026-05-08-whatsapp-onfirstopen-lost-on-reconnect.md`.

