# NanoClaw Architecture

Current-state architecture documentation. Last updated: 2026-03-25.

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
   ├── formatMessages(db.getMessagesSince(cursor))  →  XML prompt
   └── runContainerAgent(group, prompt, sessionId)
       ├── buildVolumeMounts() + validateAdditionalMounts()
       ├── buildContainerArgs() + applyOneCLIConfig()
       └── docker run -i --rm ... < stdin
           ↓
6. Container: Claude Agent SDK processes prompt
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
| Container user   | Non-root `node:1000`                                     |


---

## Memory System


| Scope            | Location                            | Access                           |
| ---------------- | ----------------------------------- | -------------------------------- |
| Per-group memory | `groups/{name}/CLAUDE.md`           | Read-write by group's container  |
| Global memory    | `groups/global/CLAUDE.md`           | Read-only for non-main groups    |
| Agent SDK memory | `data/sessions/{group}/.claude/`    | Auto-managed by Claude Agent SDK |
| External mounts  | `data/ipc/{group}/` validated paths | Per allowlist rules              |


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

## BenClaw: Fork Identity

This project is **BenClaw** — a fork of NanoClaw (`donkruger/benclaw`) customized as a personal AI assistant named Ben. The upstream NanoClaw provides the messaging infrastructure and container isolation. BenClaw adds a persistent cognitive layer on top.

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

