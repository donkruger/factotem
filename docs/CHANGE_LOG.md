# Change Log

Timestamped record of significant changes to this BenClaw fork.

---

## 2026-04-21

### Auth-mode toggle (`scripts/set-auth-mode.sh`)
- Added a first-class, reversible switch between two auth states for OneCLI's Anthropic credential: `api-key` (stable `sk-ant-api...`) and `oauth-workaround` (rotating `sk-ant-oat01-...` kept in sync by the launchd watcher `com.nanoclaw.oauth-refresh`).
- Source of truth is the plain-text marker `nanoclaw/.auth-mode` (gitignored). The toggle script performs all side effects atomically: marker write, `onecli secrets update`, watcher `launchctl bootstrap`/`bootout`, container stop, verification probe.
- The watcher now self-checks the marker as its first action and exits silently if the mode is not `oauth-workaround`. Prevents the watcher from overwriting a real API key with the still-rotating keychain OAuth token if the launchd plist is accidentally loaded.
- `docs/OPERATIONS.md` — added top-level "Auth Mode" section; OAuth-specific subsections wrapped under `#### Applicable only in oauth-workaround mode`. Generic pieces (known-working injection config, credential-rotation runbook) left unchanged as they apply to both modes.
- `docs/DEBUG_CHECKLIST.md` — the `Invalid API key` error-table row generalised so it covers both modes' failure causes and points at `scripts/set-auth-mode.sh status` for the distinguishing probe.
- No behavioural change to running services at time of commit; marker is seeded to `oauth-workaround` to match the state NanoClaw is already in.

### Agent-runner transient-error retry guardrail
- `container/agent-runner/src/index.ts` now recognises upstream auth/connectivity error strings returned by the Claude Agent SDK (`Invalid API key`, `API Error: Unable to connect to API`, `API Error: NNN ...`, `Failed to authenticate.`, `Credit balance is too low`) via `TRANSIENT_UPSTREAM_ERROR_PATTERNS`. On match, the agent-runner suppresses the would-be WhatsApp reply, tears down the current query (`stream.end()` + `break` to avoid iterator hangs), backs off, and re-runs the query. If the final attempt also fails, the error text passes through so a real incident is not silently swallowed.
- Retry schedule is `QUERY_RETRY_DELAYS_MS = [2000, 5000, 10000]` — up to 3 retries (4 total attempts) spanning 17s of tolerance. Calibrated from observed Anthropic server-side rejection windows of roughly 10s. Extend cautiously: each extra entry delays the user-visible failure message by that many seconds when upstream is actually down.
- Patterns are generic and apply regardless of auth mode.

### Agent model selection via `ANTHROPIC_MODEL`
- `container/agent-runner/src/index.ts` — the `query({ options: { … } })` call now passes `model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6'`. Before this change the SDK silently used its built-in default (Sonnet).
- `src/container-runner.ts` — host env var `ANTHROPIC_MODEL` is conditionally forwarded into each spawned container via `-e`.
- `~/Library/LaunchAgents/com.nanoclaw.plist` — `EnvironmentVariables` now includes `ANTHROPIC_MODEL=claude-haiku-4-5` for the current deployment.
- `docs/OPERATIONS.md` — new "Agent Model" section documents the env-var plumbing, valid values, and the "bootout + bootstrap + docker stop" update sequence (kickstart alone does not re-read the plist).
- Runtime-configurable: no rebuild required to change the model going forward, just a plist edit + NanoClaw reload + container respawn.

### Production auth switchover — OAuth → API key
- Rotated OneCLI's Anthropic secret from the rotating subscription OAuth token to a stable personal-workspace API key (`ben-bridge`). Executed in a single toggle: `scripts/set-auth-mode.sh api-key --value <key>`.
- Marker at `nanoclaw/.auth-mode` is now `api-key`; launchd watcher `com.nanoclaw.oauth-refresh` is booted out and inert; `onecli secrets update` retained the Anthropic secret's UUID (`8104c265-…`) so all selective-agent bindings stayed intact.
- First attempt with the `ben-evans` key was rejected with `invalid_request_error: Your credit balance is too low` — the toggle's verification probe caught the billing state at switchover time rather than letting it leak to WhatsApp, which is exactly what the scaffolding was designed for. Don funded the personal workspace and issued a replacement key (`ben-bridge`) which auth'd cleanly on the second push.
- Full incident trail in `ben-log/2026-04-21-api-key-switchover-attempt.md`.
- Reversible: `scripts/set-auth-mode.sh oauth-workaround` flips back in ~5s without any code rebuild.

### Host-side internal-reasoning leak filter
- `src/index.ts` gained `INTERNAL_REASONING_LEAK_PATTERNS` + `looksLikeInternalReasoningLeak()`. After stripping `<internal>…</internal>`, the filter additionally suppresses outputs that start with phrases like `No response needed`, `Already responded`, `Side conversation`, etc., which the agent had been emitting as plain text instead of wrapping.
- On match, a `WARN` is logged and the message is not sent; the agent's own reasoning no longer leaks into group chats.
- Paired tightening in `groups/global/CLAUDE.md`: added a short "never ship reasoning about whether to reply as the reply itself" rule with three example shapes that must live inside `<internal>` tags.

## 2026-04-09

### Group identity injection
- Agent containers now receive explicit group identity in two layers:
  - **Prompt header**: `<group name="..." jid="..." is_main="..." />` element in every message batch (via `formatMessages` in `src/router.ts`)
  - **System prompt**: group name, JID, and main/non-main instructions appended to the Claude SDK system prompt (in `container/agent-runner/src/index.ts`)
- `ContainerInput` now includes `groupName` field, passed from `src/index.ts` and `src/task-scheduler.ts`
- MCP server receives `NANOCLAW_GROUP_NAME` environment variable
- Prevents agents from confusing which group they're serving when operating across multiple groups

### Cross-group messaging restriction
- The `send_message` MCP tool no longer allows `target_jid` to point to group JIDs (`@g.us` or Telegram groups). Cross-messaging is restricted to DM/individual JIDs only (`@s.whatsapp.net`, etc.)
- Host-side IPC watcher (`src/ipc.ts`) enforces the same restriction as defense-in-depth: main group cannot send to other registered WhatsApp groups
- DM cross-messaging from the main group remains allowed
- Root cause: the main group agent was using `send_message(target_jid=...)` to route responses to the wrong group

### GGApps_Socials group registration
- Registered GGApps_Socials WhatsApp group (`120363424660887339@g.us`) with trigger `@Ben`, folder `whatsapp_ggapps-socials`
- Migrated 5 HITL X engagement tasks from `whatsapp_main` to `whatsapp_ggapps-socials` so approval requests flow natively in that group
- Autonomous/overnight X tasks remain on `whatsapp_main` (they post directly to X without HITL messaging)

## 2026-04-05

### Voice transcription: local whisper.cpp
- Merged `skill/voice-transcription` (base voice handling for WhatsApp) and `skill/local-whisper` (replaces OpenAI API with local whisper.cpp)
- WhatsApp voice notes are now automatically transcribed on-device using `ffmpeg` + `whisper-cli` (whisper.cpp)
- Pipeline: OGG/Opus → 16kHz mono WAV → whisper.cpp text → stored as `[Voice: <transcript>]` in SQLite
- No API key required, no network dependency, no per-minute cost
- Model: `ggml-small.bin` (~466MB) at `data/models/` — configurable via `WHISPER_MODEL` env var
- Added `/opt/homebrew/bin` to launchd PATH in `com.nanoclaw.plist` (required for `ffmpeg` and `whisper-cli`)
- New file: `src/transcription.ts` — channel-agnostic transcription module
- Source: Richard Nel's Jarvis/Telegram implementation, adapted for WhatsApp

## 2026-03-25

### Initial fork setup
- Forked `qwibitai/nanoclaw` → `donkruger/benclaw`
- Configured remotes: `origin` (fork), `upstream` (qwibitai)
- Installed OneCLI gateway and CLI for credential management
- Built `nanoclaw-agent:latest` container image (Docker)

### WhatsApp channel
- Merged `skill/whatsapp` branch — adds `src/channels/whatsapp.ts`, auth scripts, tests
- Authenticated via QR code in browser
- Registered GGA group with trigger `@Ben`, assistant name "Ben"

### Trigger pattern fix
- Changed `TRIGGER_PATTERN` from `^@Ben\b` to `(?:^|\s)@Ben\b` so `@Ben` works anywhere in a message, not just at the start

### Response prefix
- Updated WhatsApp outbound prefix from `Ben: {text}` to `👱🏻‍♂️Ben here...\n\n{text}`
- Updated bot message detection to recognize new prefix format

### BenClaw Brain integration
- Mounted `/Users/support/Documents/BenClaw Brain` → `/workspace/extra/brain/` (read-write)
- Fixed mount allowlist format (`allowedRoots` requires `{path, allowReadWrite}` objects, not strings)
- Added Kanban board columns: Core Mandates, Persistent Memory, Archived
- Rewrote `groups/global/CLAUDE.md` with brain-first operating mandate

### Documentation
- Created `docs/ARCHITECTURE.md` — full current-state architecture documentation including Brain/Kanban Pro data layer
- Created `docs/CHANGE_LOG.md` — this file
- Created `.cursor/rules/development_conventions.mdc` — development conventions and rules
- Updated `CLAUDE.md` with documentation references
- Elevated Brain documentation from a config bullet point to a first-class architecture section covering data model, board structure, data flow, and mount configuration

## 2026-03-28

### Multi-format WhatsApp attachment support
- Added text file handling (.txt, .md, .json, .yaml, .xml, .html, .css, .js, .py, .log, .sql, .toml, .ini, .env, and 20+ more extensions)
- Text files under 50KB are inlined directly in the message; larger files are saved with a reference
- Added image-as-document handling — images sent "without compression" now go through the vision pipeline
- Added generic document catch-all — any unrecognized file type (.docx, .pptx, .zip, etc.) is downloaded, saved to attachments/, and referenced for the agent
- Restructured document handling in whatsapp.ts to use else-if chains so each attachment is handled exactly once

### X (Twitter) strict mode and failure handling
- Fixed strict mode Playwright error on high-reply-count threads (92+ replies) — added `.first()` to all action button locators in reply.ts, like.ts, retweet.ts, quote.ts
- Reply script now returns structured `data.failureCategory` for agent-side decision-making: `strict_mode`, `timeout`, `replies_restricted`, `tweet_not_found`, `submit_disabled`
- Added restricted-reply detection — checks for missing reply button and X's inline restriction notice
- Added tombstone/suspended account detection in `navigateToTweet`

### Operations runbook
- Created `docs/OPERATIONS.md` — startup dependency chain, recovery procedures, health checks, common issues
- Documents the OneCLI gateway setup (docker-compose at ~/.onecli/, ports, CLI commands)
- Includes post-crash recovery checklist, orphaned container cleanup, WhatsApp re-auth, database recovery
- Referenced from README.md and CLAUDE.md

## 2026-03-27

### Excel/spreadsheet attachment support
- Added Excel (.xlsx, .xls) and CSV attachment handling to WhatsApp channel
- Downloads spreadsheet attachments to `groups/{folder}/attachments/` via Baileys `downloadMediaMessage()`
- Injects `[Document: attachments/{filename}]` reference into message content for the agent
- Created `container/skills/excel-reader/` — bash CLI wrapping Python openpyxl (extract, sheets, info, fetch, list commands)
- Added `python3-openpyxl` to container Dockerfile
- Created `/add-excel-reader` skill with setup instructions
- Added 4 test cases for xlsx, csv, and unsupported document type handling

### X (Twitter) integration
- Added X integration via browser automation (Playwright + Chrome persistent session)
- Container-side: added `x_post`, `x_like`, `x_reply`, `x_retweet`, `x_quote` MCP tools to `ipc-mcp-stdio.ts`
- Host-side: added `src/skills/x-handler.ts` IPC handler — spawns Playwright scripts as subprocesses
- Wired handler into `src/ipc.ts` default case for `x_*` IPC task types
- Installed `playwright` and `dotenv-cli` dependencies
- Auth: one-time Chrome login, session persists in `data/x-browser-profile/`
- Main group only — enforced in both MCP tools (container) and IPC handler (host)
- Fixed `is_main` flag on `whatsapp_main` registered group (was `0`, set to `1`)

### Human-like browser interaction for X integration
- Created `lib/human.ts` — human-like interaction primitives (Bezier mouse curves, keystroke-by-keystroke typing, incremental scrolling, randomised delays)
- Replaced all Playwright `.click()` / `.fill()` / `waitForTimeout()` in X scripts with `humanClick()` / `humanType()` / `humanWait()`
- Added `humanisation` config block to `lib/config.ts` with tunable parameters for typing cadence, mouse movement, click timing, and scroll behaviour
- Added `navigator.webdriver` override and Playwright property cleanup via `addInitScript` in `lib/browser.ts`
- Added `--disable-features=IsolateOrigins,site-per-process` Chrome arg to reduce automation fingerprint
- Motivation: X monitors mouse movements, tap timing, and typing cadence — fixed delays and instant interactions are primary suspension triggers

### Fix: X integration subprocess spawning under launchd
- Fixed `spawn npx ENOENT` / exit code 127 when X tools invoked via WhatsApp
- Root cause: launchd PATH (`/usr/local/bin:/usr/bin:/bin`) excludes `/opt/homebrew/bin`, breaking `npx`, `node_modules/.bin/tsx` (`#!/usr/bin/env node`), and any PATH-dependent spawn
- Fix: use `process.execPath` (the running Node binary) + `node_modules/tsx/dist/cli.mjs` directly in `src/skills/x-handler.ts`
- Documented subprocess spawning rules in development conventions and CLAUDE.md troubleshooting

### Development conventions
- Documented agent-runner source caching gotcha in CLAUDE.md and development_conventions.mdc
- Added deployment checklist for new integrations (build, rebuild, sync cache, restart, verify)
- Documented that `data/sessions/{group}/agent-runner-src/` overrides baked-in container code
- Added "Spawning Subprocesses on the Host" section — rules for avoiding PATH-related failures in launchd environments
