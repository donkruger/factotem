# Change Log

Timestamped record of significant changes to this BenClaw fork.

---

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
