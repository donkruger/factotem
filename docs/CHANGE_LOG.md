# Change Log

Timestamped record of significant changes to this BenClaw fork.

---

## 2026-05-05

### Phase 2 — Server Health panel (T8 / Wave 4)

Wave 4 fills the dashboard's default landing page with real Server Health content. Single-session sprint per the implementation plan: pure UI work composed against the already-shipped `/health` data plane, plus two small server-side additions (Tailscale IP probe + WhatsApp last-message-at lookup) so the machine-identity strip and WhatsApp card carry the data the ticket calls for. Recovery tags `pre-wave-4-2026-05-05` and `post-wave-4-2026-05-05` bookend the wave on origin.

**Server-side additions to `src/http/health.ts`.** Two new probes, both run inside the existing `Promise.all` so they share the 5-second snapshot cache:

- `probeTailscale()` — tries the three common macOS Tailscale binary paths (`/usr/local/bin/tailscale`, `/opt/homebrew/bin/tailscale`, `/Applications/Tailscale.app/Contents/MacOS/Tailscale`), runs `tailscale ip -4` with a 2-second timeout, parses the first line as an IPv4 address. Graceful null fallback if the binary is missing, exits non-zero, or returns malformed output. Don's deployment now surfaces `tailscale_ip: "100.118.188.52"` (CGNAT range) for the dashboard's machine-identity strip.
- WhatsApp `last_message_at` — extends `probeWhatsApp()` with a direct `messages` table lookup via a lazy singleton `better-sqlite3` connection (read-only, same pattern as `src/http/api.ts`). Single-row query indexed by `timestamp DESC`. Replaces the v1 placeholder that always returned null.

`HealthSnapshot.machine` type extended via composition: `MachineIdentity & { tailscale_ip: string | null }` — keeps `tailscale_ip` out of `~/.config/nanoclaw/machine.json` (it's dynamic state, not persistent identity) but ensures every `/health` snapshot carries the live value.

**Dashboard panel components.** Server Health composes a top machine-identity strip + a 4-card grid over the `/health` snapshot, polled every 5s via the existing `usePoll(getHealth, 5000)` hook. New files under `dashboard/src/components/panels/`:

- `ServerHealth.tsx` — top-level panel, owns the `usePoll` lifecycle, renders the strip + grid, hands transient errors to the connection-loss banner without dropping the last-known data
- `MachineIdentityStrip.tsx` — horizontal strip with Region · Hostname · Tailscale IP labels (Lucide Globe / HardDrive / Network icons), `bg-bg-elevated` to distinguish from the cards below
- `cards/NanoClawCard.tsx` — running/stopped Badge, PID, formatted uptime (via `formatDurationMs`), version (commit SHA when available, "—" when unknown)
- `cards/DockerCard.tsx` — engine reachable Badge, active container count, image tag (running, the "vs latest available" comparison deferred to v1.5)
- `cards/OneCLICard.tsx` — reachable Badge, latency, auth-mode pill (success for `api-key`, warning for `oauth-workaround`, neutral for unknown)
- `cards/WhatsAppCard.tsx` — authenticated Badge, time-since-last-message via `formatRelativeTime`, connection state
- `ConnectionLossBanner.tsx` — red-tinted banner shown on `/health` errors (5xx, network failure), with a deep-link to `nanoclaw/docs/OPERATIONS.md § Recovery` and a collapsible error-detail `<details>` for the message body

`dashboard/src/lib/nanoclaw.ts` `MachineIdentity` interface fixed: `platform` (always wrong) → `region` (matches the orchestrator's source of truth in `src/http/machine-identity.ts`), `created_at` added, and `Health.machine` composes with `tailscale_ip: string | null`.

`dashboard/src/app/page.tsx` collapsed to a one-line `<ServerHealth />` import — the panel owns its own polling and rendering.

**Pre-deploy + restart.** Standard discipline: lsof :7842 verified Ben's PID (83893), creds backed up to `creds.json.pre-wave-4-2026-05-05.bak`, recovery tag pushed, `bootout`/`bootstrap` cycle. New PID 574 came up clean, all probes returning data within 5s, "dashboard static export mounted" log line confirms the Wave 3 mount line still wires the new build.

**Live verification.** `/health` returns the extended schema with `machine.tailscale_ip = "100.118.188.52"` and `whatsapp.last_message_at = "2026-05-05T09:00:42.000Z"`. Dashboard root returns 9775 bytes of HTML (smaller than Wave 3's placeholder; the cards render after the first client-side poll completes). All five subsystem badges render — NanoClaw running, Docker reachable, OneCLI reachable (211ms, api-key), WhatsApp authenticated.

**Convention check.** Pure additive: new panel components, two new probes inside the existing health snapshot, one type extension via composition. No Sensitive-functionality-list touch. Rollback path: revert `src/http/health.ts`, revert `dashboard/src/lib/nanoclaw.ts`, delete `dashboard/src/components/panels/`, restore the previous `dashboard/src/app/page.tsx`.

**Brain ticket.** `T-1778240000000` (T8) flipped to `col_done`. Epic `T-1778232000000` checkpoint updated.

**Phase 2 status: COMPLETE.** Wave 5 (T9 — Activity feed + Activity Log, 10h) becomes the next sprint — fills `/activity` route with `agent_turns` data plus the step-timeline-with-nested-retries pattern from R9.

---

### Phase 1 first wave — claw-cli wizard + dashboard scaffold (T6 + T7)

Phase 1 of the Factotem Dashboard v1 epic (`epic_factotem_dash_v1`) ships its two scaffolds in parallel: the cold-start onboarding wizard (`cli/claw-setup/`) and the dashboard scaffold (`dashboard/`) that subsequent waves fill with panels. Both are purely additive new directories sharing zero files; T7 also lands a single `app.use(express.static(...))` line in `src/http/server.ts` to mount the dashboard's static export under NanoClaw's HTTP server. Recovery tags `pre-wave-3-2026-05-05` and `post-wave-3-2026-05-05` bookend the wave on origin.

**T7 — Dashboard scaffold (`T-1778239000000`).** Next.js 16 (App Router, Turbopack) + React 19 + Tailwind v4 + Comfortaa via `next/font/google`, with the marketing-site design tokens copied verbatim from `~/Documents/Factotem/src/styles/tokens.css` (radius/colour/shadow/motion variables) plus a dashboard-specific `[data-theme='dark']` extension that mirrors the light tokens. `next.config.ts` uses `output: 'export'` so production builds produce static HTML at `dashboard/out/` that NanoClaw serves directly — no separate Next runtime, no `/_next/image` server.

UI primitives: `Button` (primary/ghost variants matching marketing's rounded-pill bg-ink), `Card` (rounded-2xl hairline-bordered), `Badge` (success/warning/error/neutral with light + dark Tailwind classes), `Stat`, `Table`, `Dialog`, `AppShell` (sticky nav with backdrop blur), `ThemeToggle` (Sun/Moon Lucide icons, persists to `localStorage['theme']`). Hooks: `usePoll<T>(fn, intervalMs)` for polling, `useTheme()` for light/dark with `prefers-color-scheme` default. Lib: `nanoclaw.ts` with typed `getHealth/getGroups/getTurns/getCostDaily/getAudit` fetchers, `kp.ts` with `ticketUrl()` + `useBrainPath()` hook reading `brain_path` from `/health.machine.brain_path` per Q9, `format.ts` for relative time / cost cents / duration formatters.

`src/http/server.ts` mounts the dashboard's static export AFTER the `/api/*` routes (so API takes precedence) and is graceful when `dashboard/out/` doesn't exist yet — the orchestrator must still start cleanly on a fresh checkout, in CI, or after `npm run clean`. Confirmed at deploy: `dashboard static export mounted` log line + `curl http://localhost:7842/` returns the placeholder Server Health page with `<title>Factotem · Operator Dashboard</title>`.

**T6 — `claw-setup` cold-start wizard (`T-1778238000000`).** New npm subpackage `cli/claw-setup/` published as `bin: { "claw-setup": "dist/index.js" }`. Tech: pure TypeScript Node CLI built with `tsc` (no bundler), `@clack/prompts` for UI (matches V2 NanoClaw upstream choice per R2), `chalk` + `ora` + `qrcode-terminal` for terminal rendering, `zod` for state schema, `better-sqlite3` for the register-main-group step.

Step pipeline (idempotency-first triad): `check()` → optional `prepare()` → `execute()` → `verify()` per step. Twelve steps from `00-profile-mode` through `11-handoff` covering Q4 + R13 personas (solo / hobbyist / collaborator-invite), preflight (Node ≥24, Docker, Tailscale, TCC hard-stop), prerequisite installation, OneCLI configuration with the R3 friction 1 fix verbatim (`--type generic --header-name x-api-key`), mounts allowlist (wraps existing `setup --step mounts` skill, doesn't replace), container build, WhatsApp pairing, main-group registration, optional openMode, launchd plist install, smoke test, handoff cheat-sheet.

Atomic state file at `~/.config/nanoclaw/setup-state.json` (mode 0o600, in `~/.config/` to be TCC-safe per R3 friction 2 — NOT under `~/Documents/`). Resume semantics: state preserved on SIGINT, `--resume` picks up at the next non-`done` step. Pre-step refusal: if `store/auth/creds.json` exists and `--force` not passed, exit 1 with friendly message. Confirmed: `node cli/claw-setup/dist/index.js` from the orchestrator root with Don's live creds.json present prints the refusal and exits 1.

Step 06 (pair-whatsapp) framework is in place but the live capture-pairing-code-and-render-QR loop is marked TODO — exercising it against Don's running deployment is too risky; will be tested end-to-end on the next clean install. Step 09 (install-launchd) generates the plist with `EnvironmentVariables.PATH` including `/opt/homebrew/bin:/usr/local/bin` (R3 friction 5 fix) but never invokes `launchctl bootstrap` itself — the operator runs it manually after reviewing the generated plist.

**Q8 fix bundled.** `nanoclaw/.claude/skills/setup/SKILL.md` had three occurrences of `--type anthropic` / `type 'anthropic'` (lines 172, 173, 182) — all corrected to `--type generic` / `type 'generic'` to match the working OneCLI configuration. `diagnostics.md` checked, no further matches needed.

**Files changed.**

- New: `dashboard/` directory (package.json, next.config.ts, tsconfig.json, postcss.config.mjs, src/{app,components,lib,hooks,styles}, public/favicon.svg)
- New: `cli/claw-setup/` directory (package.json, tsconfig.json, src/{index.ts, state.ts, types.ts, ui.ts, steps/00–11})
- New: `docs/SETUP_WIZARD.md` — operator runbook for the wizard
- Modified: `src/http/server.ts` — single `app.use(express.static(...))` block guarded by `fs.existsSync()`
- Modified: `.claude/skills/setup/SKILL.md` — Q8 fix
- Modified: `.gitignore` — adds `dashboard/{out,.next,node_modules}/`

**Live verification.** PID 83893 healthy on port 7842, `/health` returns 200, WA authenticated, OneCLI reachable, image tag `072e6af` unchanged. Dashboard renders at `http://localhost:7842/` with the placeholder Server Health panel. Wizard `--help` prints flags; `--resume` framework in place; refuse-on-existing-creds verified.

**Phase 1 status: scaffolds COMPLETE.** Phase 2 (Wave 4 / T8 — Server Health panel content, 4h) becomes the next single-session sprint.

**Convention check.** Pure additive: two new directories, one one-line static-mount addition, one text-only SKILL.md correction. No Sensitive-functionality-list touch beyond the SKILL.md doc-layer text fix. Rollback path: revert `src/http/server.ts`, delete `dashboard/` and `cli/claw-setup/` directories, revert SKILL.md.

**Brain tickets.** `T-1778238000000` (T6) and `T-1778239000000` (T7) flipped to `col_done`. Epic `T-1778232000000` checkpoint updated.

---

### Phase 0 second wave — agent_turns telemetry + operator-action API (T2 + T4)

Completes Phase 0 of the Factotem Dashboard v1 epic (`epic_factotem_dash_v1`). Two commits, one wave: agent_turns telemetry capture + the `/api/*` REST surface the dashboard will consume. Recovery tags `pre-wave-2-2026-05-05` and `post-wave-2-2026-05-05` bookend the wave on origin.

**T2 — `agent_turns` SQLite table + per-turn telemetry capture (`T-1778234000000`).** Commit `611f2b2`. New 30-column SQLite table indexed by `started_at`, `(group_folder, started_at)`, and `(machine_id, started_at)` for federation-readiness. Schema captures: identity (turn_id PK, machine_id, group_folder, group_jid, agent_profile), model + tokens (model, input/output_tokens, cache_creation/read tokens, est_cost_cents), timing (started_at, finished_at, duration_ms, duration_api_ms, ttft_ms), reliability (tool_use_count, tool_error_count, retry_count, compaction_count, num_turns, exit_code, outcome, error_class), privacy-aware sizes (prompt_chars, response_chars), and linkage (session_id, is_main, is_scheduled_task, attachment_count, truncated_output).

New `src/cost.ts` module with model→cents-per-million-tokens table for Opus 4.7, Sonnet 4.6, and Haiku 4.5 (incl. cache create/read multipliers per Anthropic documented pricing). `Math.ceil` for conservative budget tracking; INTEGER cents to avoid float drift.

Wire format extended on both sides of the container boundary. The host's `ContainerOutput` and the container's `ContainerOutput` interfaces both gain the same optional telemetry fields, so older cached agent-runner-src remains compatible. The agent-runner extracts `usage`, `duration_ms`, `duration_api_ms`, `num_turns` from the SDK's result message; tracks `ttft_ms` locally on the first non-system message; counts assistant messages containing tool_use blocks. The host's `wrappedOnOutput` in `src/index.ts:runAgent` writes one `agent_turns` row per result, computing `est_cost_cents` via `estimateCostCents()`. Telemetry write failures are warn-logged and swallowed — they must not block the message-send round-trip.

**T4 — Operator-action `/api/*` routes + SIGHUP reload + `audit_log` table (`T-1778236000000`).** Commit `4b57f11`. New REST surface served by NanoClaw's HTTP server (T1) on port 7842, Tailscale-reachable. Per Q1 of the dashboard decisions, no auth middleware in v1 — Tailscale-trust is the only network boundary.

Endpoints:
- `GET /api/groups` — list with full container_config
- `GET /api/groups/:jid` — single-group detail
- `PATCH /api/groups/:jid` — additive merge into container_config + audit + SIGHUP
- `POST /api/groups/:jid/disable` — reversible flag flip + audit + SIGHUP
- `POST /api/test-message` — IPC injection into a running container's input queue (atomic temp+rename file write under `data/ipc/{folder}/input/`)
- `GET /api/turns?group=&since=&limit=` — agent_turns query with filters
- `GET /api/cost/daily?group=&model=&days=` — per-day per-model SUM rollup
- `GET /api/tasks` — scheduled task mirror
- `GET /api/audit?limit=` — recent audit entries
- `POST /api/audit/:id/undo` — restore payload_before if `reversible_until > now`

New `audit_log` SQLite table (id autoincrement PK, machine_id, ts, actor, action, target, payload_before, payload_after, reversible_until). New `src/audit-log.ts` module with `writeAudit()` / `readAuditEntries()` / `readAuditById()` / `isReversible()`. Per-action reversibility windows: group.config.update 5min, group.disable 24h, profile.update 1h, test_message.send 0 (already sent), audit.undo 0 (an undo isn't undoable).

`src/index.ts` SIGHUP handler — re-reads `registered_groups` from SQLite into the in-process map. In-flight containers continue on the old config (kill-on-apply per blueprint v2 § "Phase 8 — Operator-action safety"; drain semantics deferred to follow-up under T-1777809840000 R4). `process.kill(process.pid, 'SIGHUP')` is the trigger from the API after any state-changing PATCH/POST.

`container_config` JSON pattern preserved throughout — PATCH merges keys additively, never replaces wholesale. All endpoints additive — no replacement of existing IPC, skill, or SQLite primitives.

**Pre-deploy checklist applied** per the post-wave-1 discipline: lsof :7842 verified before deploy, creds backed up to `auth.predeploy-20260505-122420`, recovery tag pushed, no errors during `bootout`/`bootstrap`. WhatsApp connected at 12:34:26 SAST, agent_turns + audit_log schemas migrated cleanly.

**Live state at wave close.** PID 66244 running. All five new endpoints (`/api/groups`, `/api/audit`, `/api/turns`, `/api/cost/daily`, `/api/tasks`) return 200. agent_turns + audit_log schemas present. End-to-end telemetry capture verifies on the next real GGA inbound — first row will land within 5s of the agent reply.

**Files changed.** New: `src/cost.ts`, `src/audit-log.ts`, `src/http/api.ts`. Modified: `src/db.ts` (schemas), `src/types.ts` (no-op pass-through; verified), `src/container-runner.ts` (wire format), `src/index.ts` (telemetry write + SIGHUP handler + IPC injection helper), `src/http/server.ts` (mountApi + ApiDeps), `container/agent-runner/src/index.ts` (telemetry emit). Sync: agent-runner cache copied to all 7 per-group `data/sessions/*/agent-runner-src/` directories.

**Brain tickets.** `T-1778234000000` (T2) and `T-1778236000000` (T4) flipped to `col_done`. Epic `T-1778232000000` checkpoint updated.

**Phase 0 status: COMPLETE.** All 5 prerequisites (T1 + T2 + T3 + T4 + T5) shipped. Phase 1 (claw-cli wizard T6 + dashboard scaffold T7) is now unblocked.

---

### Phase 0 first wave — Factotem Dashboard v1 prerequisites (T5 + T1 + T3)

First implementation wave of the Factotem Operator Dashboard v1 epic (`epic_factotem_dash_v1`, Brain ticket `T-1778232000000`). Three of the five Phase 0 prerequisites land together so the deployment dance (build + restart) amortises across them.

**T5 — Baileys credentials permissions hardening (`T-1778237000000`).** Resolves the verified vulnerability from `ben-log/2026-05-03-baileys-creds-world-readable.md` where `store/auth/creds.json` and ~160 sibling pre-key/sender-key files were created with mode 0644 (world-readable). New module `src/channels/auth-permissions.ts` exports `secureAuthDir(authDir)` which (a) walks the directory at startup tightening every file to 0o600, and (b) registers an `fs.watch` on the directory chmodding 0o600 on every subsequent write. Wired into `whatsapp.ts:connectInternal()` immediately after `mkdirSync` and before `useMultiFileAuthState`. Verified post-re-pair: all 33 files in the new `store/auth/` are 0o600 including `creds.json`.

**T1 — `/health` HTTP endpoint + machine-identity (`T-1778233000000`).** Stands up the Tailscale-local HTTP server NanoClaw will use to serve the dashboard. Three new modules under `src/http/`:
- `server.ts` — Express server bound to `0.0.0.0` on `NANOCLAW_HTTP_PORT` (default 7842; chosen to avoid collision with common dev-tool ports — see incident below).
- `health.ts` — JSON snapshot endpoint covering machine identity, NanoClaw process state, Docker engine + image tag, OneCLI reachability + auth-mode, WhatsApp authentication, and open-DM placeholder. Cached 5s.
- `machine-identity.ts` — reads or auto-creates `~/.config/nanoclaw/machine.json` on first startup. UUID v4 + hostname + region (default `Local`) + Brain path (per Q9 — promoted from hardcoded constant). File mode 0o600.

Server-start integrated into `src/index.ts` after channel registration and IPC watcher startup, before message-loop kickoff. The configuration convention (`PROJECT_ROOT` now exported from `config.ts`; new `NANOCLAW_HTTP_PORT` constant) keeps everything in one place.

**T3 — Container image versioning (`T-1778235000000`).** `container/build.sh` now captures `git rev-parse --short HEAD` and tags the built image with both `nanoclaw-agent:latest` and `nanoclaw-agent:{git-sha}`. The SHA is also written to `nanoclaw/.container-image-tag` (gitignored), read by `health.ts` so the dashboard can compare running tag vs latest available. First build produced `nanoclaw-agent:d7e061b` confirming the workflow.

**Incident during initial deploy — EADDRINUSE corrupted creds.json.** First deploy attempt at 11:53 SAST crashed because the original default port 3000 collided with Don's local Factotem marketing-site dev server. The synchronous EADDRINUSE became an uncaught exception, killing Node mid-Baileys-write and truncating `creds.json` to 0 bytes. Two code fixes in this same wave:
- Default port changed `3000 → 7842` in `src/config.ts` — coexistence-aware default that doesn't collide with common dev tooling (Vite, Next, Webpack, etc.).
- `src/http/server.ts` uses `server.on('error', ...)` for graceful EADDRINUSE handling — the dashboard endpoint becomes unavailable but NanoClaw never crashes from a port conflict.

Operator action required for recovery: WhatsApp re-pair via the standard `setup/index.ts --step whatsapp-auth` procedure (third attempt succeeded in 17s with code R5C9-4YM9). Live system verified post-recovery: PID 31080 running, `/health` returns 200, `whatsapp.authenticated: true`, OneCLI reachable at 70ms, image tag matches HEAD.

Full incident analysis + 6 productisation signals (default-port-coexistence; `app.listen` graceful errors; Baileys' non-atomic creds write; pre-deploy port probe missing; non-disruption invariant violation; pairing-code-lifetime brittleness) in `~/Documents/NanoClaw/ben-log/2026-05-05-eaddrinuse-corrupted-creds-json.md`.

**Files changed.** New: `src/channels/auth-permissions.ts`, `src/http/server.ts`, `src/http/health.ts`, `src/http/machine-identity.ts`. Modified: `src/channels/whatsapp.ts`, `src/config.ts`, `src/index.ts`, `package.json` (added `express` + `@types/express`), `package-lock.json`, `container/build.sh`, `.gitignore`. Recovery point: git tag `pre-phase-0-2026-05-03` covers the pre-Phase-0 baseline.

**Operator runbook updates.** `OPERATIONS.md` and `ARCHITECTURE.md` updates deferred to T-1778246000000 (Phase 8 verification) per the epic's plan.

**Brain tickets.** `T-1778233000000`, `T-1778235000000`, `T-1778237000000` flipped to `col_done`. Epic `T-1778232000000` checkpoint updated.

---

## 2026-05-03

### Global flip to Haiku (config-only) — "no Sonnet, no Opus"

Don directed all scenarios to default to Haiku to maximise cost certainty during the T-1777809840000 convention-spike runway. Pure config change, no code:

- `ANTHROPIC_MODEL` in `~/Library/LaunchAgents/com.nanoclaw.plist` flipped from `claude-sonnet-4-6` → `claude-haiku-4-5-20251001` via `plutil -replace`.
- All per-group `containerConfig.model` overrides cleared via `UPDATE registered_groups SET container_config = json_remove(container_config, '$.model')`. GGA's Opus override and GGApps_Socials's redundant Haiku override are both gone.
- `evaluateOpenMode`'s hardcoded `model: 'claude-haiku-4-5-20251001'` default for new auto-registered open_dm groups **kept** as defense-in-depth — open_dm stays on Haiku even if `ANTHROPIC_MODEL` is later changed back.
- `launchctl bootout` + `launchctl bootstrap` to reload plist env (kickstart alone doesn't re-read), then `docker stop` running nanoclaw containers so they respawn with the new env.

Reversal: edit plist, `bootout`/`bootstrap`. Per-group overrides can be re-set via SQLite if specific groups need Sonnet/Opus back.

### Per-group model override (Phase 0 of T-1777809840000) — stop the Sonnet bleed

Cost-unblock: Don's Sonnet spend was the trigger for the Agent Configuration Convention spike (T-1777809840000), but the convention itself is 2-3 weeks of design work. This change lands the minimal mechanism *now* so cost-sensitive groups can swap models today, without prejudging the convention's profile schema.

**Code change.** New `model?: string` field on `ContainerConfig` (`src/types.ts`), threaded through `ContainerInput` in both `src/container-runner.ts` and `container/agent-runner/src/index.ts`, surfaced at the SDK call site (`container/agent-runner/src/index.ts:501`). Resolution order:

```
containerInput.model (per-group)
  → process.env.ANTHROPIC_MODEL (host plist global)
  → 'claude-sonnet-4-6' (hardcoded fallback)
```

`runAgent` in `src/index.ts` and `runScheduledTask` in `src/task-scheduler.ts` both pass `group.containerConfig?.model`. Scheduled tasks inherit the host group's model — task-level override (Option C from T-1777030260003) deferred to a follow-up under T-1777809840000.

**`evaluateOpenMode` defaults new open_dm groups to Haiku** at auto-registration time (`src/open-mode.ts`), so future strangers automatically get the cheap profile without operator intervention.

**Per-group assignments configured (Mark's recommendation 2026-04-24):**

| Group | Model | Why |
|---|---|---|
| `whatsapp_main` (GGA) | `claude-opus-4-7` | Dev-facing, multi-step reasoning |
| `whatsapp_ggapps-socials` | `claude-haiku-4-5-20251001` | X tasks, pattern execution |
| `whatsapp_open-dm-*` (3 existing + future) | `claude-haiku-4-5-20251001` | Stranger sessions, narrowed tools |
| `whatsapp_example` (Water Watch), `whatsapp_don-kruger-dm`, `whatsapp_richard-nel-dm` | inherits `claude-sonnet-4-6` from `ANTHROPIC_MODEL` env | Customer-facing + operator DMs |

**Configuration via SQLite + restart** (no DB schema migration — `container_config` JSON already accepts arbitrary keys; same pattern as `agentProfile` and `openMode` from the open_dm spike). Operator runbook: `OPERATIONS.md` § "Per-Group Model Override".

**Phase relationship:** This is Phase 0 of T-1777809840000. Phase 1 (the convention spike) will migrate `containerConfig.model` into a profile-shaped schema (`profile.model`), with groups referencing profiles by name. The migration is mechanical — no behavioural change for the operator.

**Files changed.** Modified: `src/types.ts`, `src/container-runner.ts`, `src/index.ts`, `src/task-scheduler.ts`, `src/open-mode.ts`, `container/agent-runner/src/index.ts`, `docs/OPERATIONS.md`. Recovery point: git tag `pre-phase-0-2026-05-03` on origin.

---

### Open DM mode (`agentProfile: 'open_dm'`) — accept WhatsApp DMs from any sender

Ben previously dropped any message from a chat that wasn't pre-registered. This change adds an opt-in mode that auto-onboards unknown WhatsApp DM senders into a narrowed agent profile. Spike ticket: `T-1746026520000` in Brain.

**Routing change.** New optional `tryAutoRegister` callback on `WhatsAppChannelOpts` is invoked at the channel gate (`src/channels/whatsapp.ts:246-252`) before the `if (groups[chatJid])` drop check. The orchestrator's implementation in `src/index.ts` `channelOpts` registers the JID iff (a) `openMode.enabled` on the main group, (b) chat is unregistered, (c) JID looks like a personal DM (`@s.whatsapp.net` or `@lid`), (d) `dailyBudgetCents` is configured (fail-closed), (e) JID is not the bot's own `me.id` from `store/auth/creds.json`, and (f) the inbound is not `msg.key.fromMe`. The gate then re-fetches `registeredGroups()` so the same event proceeds with the new group registered.

**`agentProfile` field on `ContainerConfig`.** New string field (`'main' | 'standard' | 'open_dm'`, optional) persisted in the existing `container_config` JSON column — no schema migration. Threaded into `ContainerInput` and used by the agent-runner and container-runner to switch behaviour without per-callsite branching.

**Tool / permission narrowing for `open_dm` (R1).** In `container/agent-runner/src/index.ts:507`, `containerInput.agentProfile === 'open_dm'` selects:
- `allowedTools: ['Read', 'WebFetch', 'WebSearch', 'Glob', 'Grep', 'TodoWrite', 'mcp__nanoclaw__send_self']`
- `disallowedTools` explicitly enumerates Bash, Write/Edit, Task*/TaskOutput*/TeamCreate/TeamDelete, SendMessage, NotebookEdit/Skill/ToolSearch, all crons, and every other `mcp__nanoclaw__*` tool (defense-in-depth)
- `permissionMode: 'default'` (NOT `bypassPermissions`)
- `allowDangerouslySkipPermissions: false`

**Brain isolation (R2).** Host-side filter in `src/container-runner.ts:222-238`: when `agentProfile === 'open_dm'`, the `additionalMounts` allowlist is post-filtered to drop any mount whose `containerPath` is in `{'brain', 'global'}`. Also skips the `/workspace/global` read-only mount unconditionally for `open_dm`. The Brain is *absent from the filesystem*, not just tool-gated. open_dm groups also skip the `groups/global/CLAUDE.md` template copy in `registerGroup` so they don't inherit the operator's curated memory.

**`send_self` MCP tool.** New narrow tool in `container/agent-runner/src/ipc-mcp-stdio.ts` that only emits a message back to the originating chat — never accepts `target_jid`. Replaces `send_message` for `open_dm` sessions.

**Token-bucket rate limiter, SQLite-backed.** `src/open-rate-limit.ts` exposes `consume(senderJid, limit) → {allowed, retryAfterSec}`. State persists in `open_rate_buckets (sender_jid PK, tokens REAL, last_refill TEXT)` so restarts don't reset attacker quota. Gated in `onMessage` for `agentProfile === 'open_dm'` chats only — legacy DMs unaffected. Defaults `tokensPerHour: 5, burstMax: 3`. On deny, sends a single canned reply via `channel.sendMessage` and returns; no agent invocation.

**Daily host-side cost cap.** `src/open-mode.ts` `isOverBudget` / `recordSpawnSpend` against `open_spend_log (date PK, container_count, est_cost_cents)`. Checked in `runAgent` before spawning an `open_dm` container. On exceed, logs warning and returns success without spawning (silent drop — no canned reply, since revealing the cap to a flooder gives feedback). `dailyBudgetCents` and `estCostCentsPerInvocation` (default 4) live on the main group's `containerConfig.openMode`.

**OneCLI agent identifier sharing.** `src/container-runner.ts:305-313` — `open_dm` containers reuse the default OneCLI agent (the one main uses) instead of provisioning per-stranger agent identifiers. Per-stranger identifiers would each require a manual `OneCLI dashboard → Grant access` click; not viable for "open to anyone". Spend mixes with main's attribution in OneCLI; the application-layer daily-budget cap is the real ceiling.

**Kill switch.** Flipping `containerConfig.openMode.enabled = false` on the main group (and restarting NanoClaw to reload the in-memory `registeredGroups`) immediately stops new auto-onboarding. Existing `open_dm` groups remain registered until removed manually.

**Iterative bugs found and fixed during live testing (same day):**
1. Original orchestrator-side `onMessage` hook never fired for unregistered chats — channel layer drops them at line 247 before calling `onMessage`. Fix: moved the hook to a channel-side `tryAutoRegister` callback called *before* the gate. Logged in `ben-log/2026-05-03-open-dm-test-channel-gate-and-wa-delivery.md`.
2. Bot's own JID got auto-registered (`whatsapp_open-dm-27752007263`) via WA self-chat / cross-device echo events. Fix: skip `tryAutoRegister` when `msg.key.fromMe === true`; also reject `chatJid` matching the bot's own phone JID in `evaluateOpenMode`.
3. External-sender chatJid arrives as `@lid` (Multi-Device protocol) when key exchange hasn't completed; my `isOpenableDmJid` only accepted `@s.whatsapp.net`. Fix: accept `@lid` too. Folder slug from LID is digits-only and valid.
4. Per-stranger OneCLI agent identifiers required manual dashboard grants → 401 retry-storms in agent-runner. Fix: `open_dm` reuses main's agent identifier. Logged in `ben-log/2026-05-03-open-dm-onecli-agent-401-and-trigger-removal.md`.

**Trigger-requirement removed for legacy personal DMs (`whatsapp_don-kruger-dm`, `whatsapp_richard-nel-dm`).** `requires_trigger` flipped from 1 → 0 via SQL after the open_dm rollout exposed how restrictive the default felt. Every inbound now spawns the agent. No daily cost cap on legacy DMs (the cap is `open_dm`-only). One-shot: `UPDATE registered_groups SET requires_trigger=0 WHERE folder IN ('whatsapp_don-kruger-dm','whatsapp_richard-nel-dm');` + restart.

**Files changed.** New: `src/open-rate-limit.ts`, `src/open-mode.ts`. Modified: `src/types.ts`, `src/db.ts`, `src/index.ts`, `src/container-runner.ts`, `src/channels/whatsapp.ts`, `container/agent-runner/src/index.ts`, `container/agent-runner/src/ipc-mcp-stdio.ts`. Recovery point: git tag `pre-open-dm-spike-2026-05-03` on origin.

**Operational runbook.** See `OPERATIONS.md` § "Open DM Mode" for enable/disable, monitoring, kill switch, daily budget config.

---

## 2026-04-24

### OAuth watcher made reliable under launchd; marker moved out of Documents/
- Root cause: the 2026-04-21 `com.nanoclaw.oauth-refresh` watcher read its mode marker from `nanoclaw/.auth-mode`. On macOS, launchd-spawned processes cannot read paths under `~/Documents/` without an explicit TCC grant (`Full Disk Access`). Every watcher tick since install returned `Operation not permitted` on the `head` call, fell through the empty-mode branch, and exited 0 — `runs` counter and `last exit code` both green, silent no-op. Took Ben down for ~2 h the first time the project was actually in `oauth-workaround` mode. Evidence and reproduction in `ben-log/2026-04-24-oauth-watcher-cannot-read-keychain-under-launchd.md`.
- Moved the marker to `~/.config/nanoclaw/auth-mode` (same dir as the existing `mount-allowlist.json`). This location is outside TCC-protected roots and readable from launchd context. Updated readers (`scripts/set-auth-mode.sh`, `/Users/support/.local/bin/nanoclaw-oauth-refresh.sh`), `CLAUDE.md`, `docs/OPERATIONS.md`, and removed the stale `.auth-mode` gitignore entry.
- Rewrote `nanoclaw-oauth-refresh.sh` with **visible observability**: each tick emits a single status line (`ok | rotated | disarmed | probe-skipped | warn`) to stdout (captured by the plist's `StandardOutPath`) and overwrites `/tmp/nanoclaw-oauth-refresh.health`. `scripts/set-auth-mode.sh status` now reads the health file and reports tick age. The prior revision logged via `/usr/bin/logger` to syslog, which was silently discarded by the unified log — a design decision that hid the outage entirely.
- Probe match loosened from `authentication_error` + `invalid x-api-key` (two literal-string ANDs) to just `authentication_error`. Catches a broader set of server-side rejections (e.g. rotated token revocations that return `Invalid bearer token` instead) without losing precision — the only `authentication_error` path through the OneCLI proxy is a credential problem.
- No API changes. `scripts/set-auth-mode.sh {status|api-key|oauth-workaround}` unchanged; backup of the old watcher kept at `/Users/support/.local/bin/nanoclaw-oauth-refresh.sh.bak-2026-04-24` for rollback.

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
