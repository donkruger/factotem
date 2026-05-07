# Change Log

Timestamped record of significant changes to this BenClaw fork.

---

## 2026-05-07

### Phase 1 / Tauri Doctor — M1.1 + M1.2 (cli/claw-doctor scaffold + multi-instance probe)

First execution session for Phase 1 of the embedded recovery experience. Don approved supervisor mode (long-term Electron Factotem talks to NanoClaw via `/api/*`; doesn't replace it) and asked for explicit multi-instance detection because his machine has both `com.nanoclaw` (V1 fork) and `com.nanoclaw-v2-0a765b3b` (V2 upstream) loaded simultaneously. This commit ships M1.1 (project scaffold + bundled `.app`) and M1.2 (probe + tray status with multi-instance detection baked in). M1.3–M1.6 follow in subsequent sessions per [`~/.claude/plans/research/phase-1-tauri-menu-bar-design.md`](~/.claude/plans/research/phase-1-tauri-menu-bar-design.md).

**New directory: `cli/claw-doctor/`** — Tauri 2 app, Rust backend + Vite/React frontend (placeholder until M1.3 windows). 28 source files, ~5.7 MB bundled `.app`. Full file layout in `cli/claw-doctor/README.md`.

**Toolchain bumps performed during this session.** Homebrew Rust 1.77.2 → 1.95.0 (Tauri CLI 2.11.1 requires edition 2024 / Rust 1.85+). Homebrew Node 25.7.0 → 25.9.0 (the 25.7.0 binary was looking for `libllhttp.9.3.dylib` which Homebrew had moved to `9.4.dylib` — `brew reinstall llhttp node` fixed it). `cargo install tauri-cli@^2.0` succeeded after the Rust bump.

**Probe layer (`src-tauri/src/probe.rs`).** The heart of M1.2. Six parallel probes wrapped in `tokio::time::timeout`:

1. `probe_docker()` — `docker info` with 3s timeout
2. `probe_onecli()` — HTTP GET `127.0.0.1:10254/` with 2s timeout
3. `probe_nanoclaw_processes()` — `pgrep -fla "dist/index.js"` parses every matching process; `ps -o ppid=` resolves parent PID; `launchd_spawned` flag indicates parent_pid == 1
4. `probe_launchd_labels()` — `launchctl list` filtered to `com.nanoclaw*` labels (excludes `com.nanoclaw.oauth-refresh` because that's the watcher, not an orchestrator)
5. `probe_port_7842()` — `lsof -nP -iTCP:7842 -sTCP:LISTEN -F pcL` machine-readable output; cross-references PID against the process list to flag foreign owners
6. `probe_nanoclaw_http()` — HTTP GET `localhost:7842/health` with 2s timeout

Synthesis (`synthesize_overall()`) distinguishes six concrete scenarios — healthy single instance, dev-mode + launchd both running, multiple launchd labels (Don's case), process running with port unbound, foreign port owner, stack offline — and produces a human-readable headline + detail per case. The amber states explicitly *don't* trip Repair Stack (M1.3); they need operator judgement.

**Tray + menu (`src-tauri/src/tray.rs`).** Status-driven menu builder: headline emoji-prefixed (🟢 / 🟡 / 🔴 / ⚪) + secondary detail line on amber/red, "Last checked: Ns ago", three actions (Open Dashboard, Open Recovery Panel, Show diagnostic details — placeholder until M1.3), Quit. Tooltip + menu rebuilt on every probe tick. Tray icon as macOS template image so the OS tints to match light/dark menu bar.

**Entry + scheduler (`src-tauri/src/lib.rs` + `main.rs`).** Tauri 2 lib/bin split (`pub fn run()` in lib for mobile-target compat). Probe loop runs on `tauri::async_runtime::spawn` (shared tokio runtime) with `tokio::time::interval(5s)`; first tick delayed 200ms to avoid races with tray-icon construction. Window-close-requested events hide rather than quit so the tray stays alive.

**Reused primitives (no duplication).**
- `tauri-plugin-shell` + `tauri-plugin-opener` — for "Open Dashboard" and "Open Recovery Panel" — opens default browser via OS conventions, no in-app WebView (the WebView is reserved for Repair Stack and Settings windows in M1.3+)
- `~/Library/Application Support/Factotem/recovery.html` from Phase 0 (`scripts/install-recovery.sh`) — the Doctor's "Open Recovery Panel" action falls back to the github runbook URL if the file isn't installed
- `recovery-steps.json` — same step manifest planned for the M1.3 Repair Stack window; loaded via `include_str!` so it's tamper-resistant inside the bundle

**Smoke test passed.** PID 37915, 32s uptime, 69 MB RSS, 5.7 MB bundled .app. Multi-instance scenario captured live during testing: PID 71363 (`/Documents/NanoClaw/nanoclaw/dist/index.js`) owns port 7842, PID 1428 (`/Documents/NanoClaw V2/nanoclaw-v2/dist/index.js`) doesn't. Doctor's headline reads "2 NanoClaw services loaded" with detail "Loaded labels: com.nanoclaw, com.nanoclaw-v2-0a765b3b. Only one is bound to :7842; the others may be stale installs."

**Convention check.** Pure additive — entirely new directory `cli/claw-doctor/`, sibling to `cli/claw-setup/`. No orchestrator code touched. No dashboard code touched. No mutations to the running NanoClaw deployment. Reversal: delete `cli/claw-doctor/`. Zero risk.

**What ships in subsequent sessions.**
- M1.3 — Repair Stack window + sequential execution + typed-confirm gate (~1.5 days)
- M1.4 — Settings + Logs windows (~0.5 day)
- M1.5 — Code signing via Don's Apple Dev ID (~0.5 day)
- M1.6 — `claw-setup` step 11 drops the `.app` into `/Applications` (~0.5 day)

Recovery tag: `pre-phase1-m1.1-m1.2-2026-05-07` (HEAD before this commit).

---

## 2026-05-06

### Wave 9 follow-up — operator-feedback fixes

After Don's manual eyeball review of v1, five issues surfaced. All five fixed in a single follow-up commit before the v1 closeout. Recovery tags `pre-fix-2026-05-06` and `post-fix-2026-05-06` on origin.

**1.1 Group detail page returned `Cannot GET /groups/<jid>%40g.us` (broken).** Root cause: Next.js `output: 'export'` only emits one HTML file per `generateStaticParams()` entry, so only `/groups/_/index.html` existed on disk; navigating to a real JID URL hit Express's default 404. Two-part fix:

- `src/http/server.ts` — add an Express handler matching `/^\/groups\/[^/]+\/?$/` that runs after `express.static` (which falls through via `next()` on miss) and serves the `groups/_/index.html` placeholder for any group JID. The static export still wins for the literal `/groups/_/` path.
- `dashboard/src/app/groups/[jid]/page.tsx` + `GroupDetailView.tsx` — drop the `params.jid` plumbing and read the real JID from `window.location.pathname` on mount via a `useEffect`. Pre-hydration renders nothing; post-hydration the matched JID drives the existing `getGroup(jid)` poll. Hooks rules respected: the fetcher returns a never-resolving promise while the JID is null/placeholder, so `usePoll` keeps the previous state without flipping into an error.

Verified: `curl http://localhost:7842/groups/120363407726747863%40g.us/` returns 200 with 11394 bytes; same for any JID.

**1.2 Activity feed showed raw folder names + opaque expanded metrics.** Three fixes in `ActivityRow.tsx` and `ActivityFeed.tsx`:

- Friendly group name: `ActivityFeed` builds a `Map<folder, name>` from the existing `getGroups()` poll; passes `groupName` to each `ActivityRow`. The row renders the friendly name (e.g. "GGA") with the raw folder kept as a `title=` attribute on hover and surfaced explicitly in the expanded Identity section.
- Tooltips on every metric label: a TIPS map covers all 18 detail labels with plain-English explanations (e.g. "Cache create" → "Tokens stored in Anthropic's prompt cache. Charged at 1.25× input rate; saves cost on subsequent requests"). The `Detail` helper auto-resolves the tooltip from TIPS by label, so no call-site changes are needed. Labels render with a dotted underline + cursor-help hint to signal the tooltip.
- `group_folder` added to the expanded Identity section as a first-class field (mono small) so the operator can still see the routing key when they expand a row.

**1.3 Cost CSV / JSON exports were too minimal.** Don's request: include enough context that an LLM agent receiving the export can interpret it. Rewrote both export builders in `dashboard/src/app/cost/CostView.tsx`:

- New `ExportContext` type carries `generatedAt`, `todayIso`, `rows7d`, `rows30d`, `budgetCents`, `alertThresholds`, `mainGroupName`.
- CSV export now begins with `#`-prefixed metadata lines (today's spend, budget, % used, alert thresholds), followed by a per-model 30-day totals section, followed by the daily breakdown table. Spreadsheet readers handle `#` lines as a single non-data column (visible but inert).
- JSON export is now a structured object: `{ generated_at, deployment, today_summary, totals, daily_breakdown_30d }`. The `model_breakdown_30d` map gives an agent ready-to-use per-model totals. Cents and dollars both included on every relevant value.

**1.4 Alerts were confusing + recovery URL went to a github 404.** Two changes in `src/http/alerts.ts` + `dashboard/src/components/panels/AlertsList.tsx`:

- Ghost-action alert wording softened: title is now "N agent replies may have skipped expected actions" (was "N possible ghost-action turns in last 24h"). Detail explains in plain English what a ghost action is and notes that the heuristic isn't perfect. Recommendation links operators to Activity → outcome=success and references the canonical 2026-04-17 ben-log incident.
- Recovery URL changed from `ben-log/2026-04-17-ghost-tickets.md` (which is local-only per the ben-log convention — not in any git repo) to `docs/OPERATIONS.md#recovery` (which exists in donkruger/benclaw on the main branch).
- AlertsList now opens with a Card explaining all five detection signals in plain English so the operator can read what each alert means without diving into source code.

**1.5 Audit log was hard to read at first glance.** Three additions to `AuditLogTable.tsx`:

- New `summarise(entry)` helper produces a one-line human summary per entry (e.g. "Updated group: name → 'Richard Nel (DM)'", "Disabled group", "Restart Stack invoked", "Cost alert test fired"). Best-effort — falls back to the raw action when payloads can't be parsed. Renders in a new Summary column between Action and Target.
- Top-of-panel explanatory Card covers (a) what gets logged, (b) why it's useful (undo, forensics, future multi-operator audit), (c) how to use the row-expand and exports.
- CSV / JSON export buttons mirroring the Cost panel: CSV includes id / ts / action / target / reversible_until / summary / payload_before / payload_after; JSON includes parsed payloads + the summary string per entry.

**Convention check.** Pure additive UI/server work — no schema changes, no Sensitive-functionality-list touch, no changes to NanoClaw's message processing path. The Express middleware addition is conditional on `dashboardOut` existing; it falls through cleanly when the static export is missing.

**Live verification (post-restart, PID 43968).**
- `/groups/120363407726747863%40g.us/` and `/groups/27845553333%40s.whatsapp.net/` both return 200.
- `/api/alerts` returns the ghost-action alert with the corrected URL pointing at `docs/OPERATIONS.md#recovery`.
- All 6 dashboard routes still render.

**Recovery tags.** `pre-fix-2026-05-06` (HEAD before this commit) + `post-fix-2026-05-06` (after) on origin.

---

## 2026-05-05

### Phase 8 — E2E verification suite (T14 / Wave 9)

Wave 9 ships the verification harness for the Factotem Operator Dashboard v1. Two artifacts: an executable bash script that runs the agent-runnable checks against the live system, and a new operator runbook section covering the full flow (automated + hybrid + manual). Recovery tags `pre-wave-9-2026-05-05` and `post-wave-9-2026-05-05` bookend the wave on origin. v1's "shipped" final entry waits for Don's bonus-check confirmation in a follow-up commit.

**`scripts/verify-dashboard-v1.sh`.** Bash script with three flags (`--check N` to run one, `--json` for machine-readable, `--expected-region` for the federation-footprint check). Runs 10 checks and prints PASS/FAIL/MANUAL per check + a summary line. Exit code 0 if no FAIL; 1 otherwise. MANUAL checks don't block exit.

The 10 checks per the blueprint v2 verification plan:

1. `/health` reachable — verifies `nanoclaw.running=true`, `whatsapp.authenticated=true`, parses machine identity (`region`, `tailscale_ip`)
2. Dashboard root loads in <2s — `time_total` from curl
3. **HYBRID** Telemetry round-trip — operator sends a message to GGA, then re-runs with `--check 3` to look for a fresh agent_turns row in the last 60s
4. Cost reconciliation — sums `agent_turns.est_cost_cents` for today and compares to `/api/cost/daily` (1¢ tolerance)
5. PATCH + SIGHUP — picks the first non-main group with a name set, PATCHes the `name` field, GETs to verify, captures audit_id for check 6
6. Audit + undo — POSTs `/api/audit/:audit_id/undo`, GETs to verify the name reverted
7. **MANUAL** KP cross-link — operator clicks through `/groups/:jid` related-ticket link
8. Misclick prevention (best-effort) — greps `/groups/_/` HTML for the typed-confirm primitive; falls back to MANUAL if not detectable from static export
9. **MANUAL** Theme toggle — operator clicks the sun/moon icon and confirms persistence across reload
10. **MANUAL** Federation footprint — operator edits `~/.config/nanoclaw/machine.json` `region`, restarts via `bootout`+`bootstrap`, re-runs with `--check 10 --expected-region "<value>"` to confirm the new region appears in `/health`

**Side effect of checks 5+6.** The script PATCHes the first available non-main group's `name` field, then undoes the change via the audit endpoint. Two clearly-labelled audit entries (`group.config.update` + `audit.undo`) appear in `/api/audit`. No state remains modified.

**Bug surfaced + fixed during script development.** First implementation used `GROUPS=$(curl...)` to capture the API response. Bash silently ignored the assignment because `GROUPS` is a built-in readonly array containing the user's group IDs; `${#GROUPS[0]}` returns the staff group ID length ("20"), which then errored out the downstream jq pipeline. Fixed by renaming to `NC_GROUPS`. This is exactly the kind of footgun the verification suite will keep operators from rediscovering on every fresh deployment.

**First-run results (PID 97826, 2026-05-05).** 5 PASS / 0 FAIL / 5 MANUAL — every automated check passed cleanly:

```
✓ PASS  1 — /health 200 · pid=97826 region=Local tailscale=100.118.188.52
✓ PASS  2 — / rendered HTTP 200 in 0.001709s
~ MANUAL 3 — operator must send a message
✓ PASS  4 — Cost reconciliation matches: agent_turns sum=0¢, /api/cost/daily=0¢ (Δ=0¢)
    target group: 27845553333@s.whatsapp.net  (current name: "Don Kruger (DM)", version: 0)
✓ PASS  5 — PATCH applied + SIGHUP reload took effect. audit_id=2
✓ PASS  6 — Undo round-trip works — name reverted to "Don Kruger (DM)"
~ MANUAL 7 — operator must click through KP cross-link
~ MANUAL 8 — confirm primitive surface-detected in JS bundles, not in HTML
~ MANUAL 9 — operator must toggle theme + reload
~ MANUAL 10 — operator must edit machine.json + bootout/bootstrap
```

**`docs/OPERATIONS.md` § "Dashboard v1 verification".** New section appended at the end. Documents the synopsis, automated checks, hybrid checks, manual eyeball checks, single-flag invocation reference, and what "shipped" means. Operator runbook for repeating verification on every future deploy.

**Convention check.** Pure additive: one new script, one new docs section. No code changes to `src/`, `dashboard/src/`, or `cli/claw-setup/`. The script's only side effect is two audit-log entries that immediately undo themselves. No Sensitive-functionality-list touch.

**Brain ticket.** `T-1778246000000` (T14) flipped to `col_done`. **Epic `T-1778232000000` flip to `col_done` waits for Don's confirmation that the four manual / eyeball checks pass.**

**Phase 8 status: automated portion COMPLETE.** Awaiting operator confirmation on the bonus checks before the v1 closeout entry lands.

---

### Phase 6 — Alerts panel + audit_log + Restart Stack (T12 / Wave 7)

Wave 7 ships the second-to-last v1 panel: `/alerts` + `/audit`. Surfaces the Round 7 ben-log-grounded top-5 failure modes as proactive alerts, exposes the audit log with reversible-undo affordances, and adds the env-gated Restart Stack recovery action per the Q6 cascade. Recovery tags `pre-wave-7-2026-05-05` and `post-wave-7-2026-05-05` bookend the wave on origin.

**Server-side additions.** Three:

- NEW: `nanoclaw/src/http/alerts.ts` — alert-detection module. Computes the 5 Round 7 alerts lazily on each `/api/alerts` request, with a 30s cache so log-tailing doesn't thrash. Detection logic per alert:
  1. **`docker_wedge`** — pulls from the existing health snapshot. Triggered when `docker.running === false` OR `onecli.reachable === false`. When BOTH are down, the response includes `recovery_action: 'restart_stack'` so the dashboard renders the recovery button. Severity: critical.
  2. **`error_string_in_reply`** — tails the last 2,000 lines of `logs/nanoclaw.log` for the patterns `Invalid API key | API Error: | Failed to authenticate | 401 Unauthorized` within a 1-hour window. Severity: critical.
  3. **`auth_mode_freshness`** — only fires when `auth-mode == oauth-workaround`. Reads `/tmp/nanoclaw-oauth-refresh.health` mtime. Critical when missing or > 300s old; warning at 90–300s.
  4. **`ghost_action_divergence`** — v1 heuristic. SQLite query: count `agent_turns` rows in the last 24h with `outcome=success`, `tool_use_count=0`, AND `prompt_chars > 200`. Severity: warning. Includes a deep link to the canonical ghost-tickets ben-log entry.
  5. **`wa_respawn_counter`** — tails `nanoclaw.log` for `Reconnecting | Connection terminated | Connection closed` lines in the last 60 seconds. Severity: warning when count > 3.
- MODIFIED: `nanoclaw/src/http/api.ts` — two new endpoints:
  - `GET /api/alerts` — returns `{ alerts, restart_stack_enabled, detected_at }`. The `restart_stack_enabled` flag is read from the `NANOCLAW_DASHBOARD_ENABLE_RESTART_STACK` env var (must be exactly `"1"` to be true).
  - `POST /api/restart-stack` — env-var-gated destructive recovery. **Returns 404 (not 403) when the env var isn't set, per the Q6 spec — the endpoint should appear not to exist.** When enabled: runs `pkill -9 -f 'Docker Desktop'` followed by `pkill -9 -f 'com.docker.backend'` (per Round 7 Rank 1 — both must be killed; UI process alone is insufficient). pkill exit code 1 (no matching process) is treated as success. Audited as `restart_stack.invoke`.
- MODIFIED: `nanoclaw/src/audit-log.ts` — `restart_stack.invoke` added to the `AuditAction` union with 0 reversibility (the kill already happened).

**Dashboard routes.** Two new top-level routes at `/alerts` and `/audit`, plus 5 new components:

- `app/alerts/page.tsx` + `panels/AlertsList.tsx` — top-level Alerts panel polling `/api/alerts` every 10s. Sorts critical → warning → info; calm "no active alerts" state when the list is empty (with a green check + the signals it watches). Refresh-nonce pattern lets the Restart Stack button trigger an immediate re-poll after invocation.
- `panels/AlertCard.tsx` — single alert rendering. Severity-coloured left border + matching Lucide icon (AlertTriangle critical, AlertCircle warning, Info info). Title + detail + italic recommendation + footer with relative-time stamp, optional recovery-procedure link (ExternalLink icon), and inline `<RestartStackButton>` when the alert carries `recovery_action: 'restart_stack'`.
- `panels/RestartStackButton.tsx` — typed-confirm action. Returns `null` when `enabled === false` (the dashboard never shows the button if the operator hasn't opted in via env var). When enabled: red-accented Button → ConfirmDialog with `confirmText: "RESTART STACK"` → `postRestartStack()` on confirm. Success banner auto-clears after 5s. Reuses the existing `ConfirmDialog` primitive shipped in Wave 6.
- `app/audit/page.tsx` + `panels/AuditLogTable.tsx` — Audit log viewer polling `/api/audit?limit=200` every 30s. Five-column Table (When / Action / Target / Reversible / Actions) with row-expand to reveal pretty-printed `payload_before` / `payload_after` JSON. JID-shaped targets become deep links to `/groups/:jid`. Reversibility badge auto-flips to "Expired" when `reversible_until` passes (recomputed on render against `Date.now()`, no separate timer needed). Action label map renders friendly short names (e.g. `group.config.update` → "Config update"). Undo flow: typed-confirm (`confirmText: "UNDO"`, non-destructive variant) → `postAuditUndo(id)` → bumpRefresh.

**Dashboard infrastructure additions (`dashboard/src/lib/nanoclaw.ts`).** Three new helpers + three new types:

- Types: `Alert`, `AlertSeverity`, `AlertsResponse` mirroring the server's response shapes
- Helpers: `getAlerts()`, `postRestartStack()`, `postAuditUndo(id)`
- The existing `AuditEntry` interface was updated to add the missing `ts` and `actor` fields (always returned by the server but previously not surfaced in the type).

**Nav update.** `NavLinks.tsx` extended with Alerts + Audit links — six routes total now (Server Health / Activity / Groups / Cost / Alerts / Audit).

**Pre-deploy + restart.** Standard discipline: lsof :7842 confirmed Ben's PID 56663, creds backed up, recovery tag pushed, `bootout`/`bootstrap` cycle. New PID 97826 came up clean.

**Live verification (post-restart, PID 97826).**

- All endpoints 200: existing six + new `/api/alerts`. `/api/restart-stack` returns 404 as designed (env var not set on Don's plist, so button is hidden and endpoint appears not to exist).
- `/api/alerts` returns `{ alerts: [], restart_stack_enabled: false, detected_at }` — system is healthy with no active alerts.
- All six dashboard routes return 200: `/`, `/activity`, `/groups`, `/cost`, `/alerts`, `/audit`. 9 static routes generated total.

**Restart Stack opt-in procedure (operator runbook).** To enable the button: add `<key>NANOCLAW_DASHBOARD_ENABLE_RESTART_STACK</key><string>1</string>` to the `EnvironmentVariables` dict in `~/Library/LaunchAgents/com.nanoclaw.plist`, then `launchctl bootout` + `launchctl bootstrap` to reload. The `/api/alerts` response will flip `restart_stack_enabled: true`, the dashboard's button surface re-enables on the next 10s poll, and `POST /api/restart-stack` becomes available. To disable: remove the env var and bootout/bootstrap.

**Convention check.** Pure additive: 1 new server module, 2 new endpoints, 1 new audit action type, 5 new dashboard components, 2 new routes, 3 new lib helpers + 3 types. ⚠ **Convention impact (medium):** the Restart Stack endpoint invokes destructive host commands (`pkill -9` of Docker Desktop + the docker backend). Mitigation per Q6: env-var opt-in (route returns 404 when env var unset; button hidden in UI) + typed-confirm "RESTART STACK". Rollback: unset the env var; both surfaces disappear. No Sensitive-functionality-list touch.

**Brain ticket.** `T-1778244000000` (T12) flipped to `col_done`. Epic `T-1778232000000` checkpoint updated.

**Phase 6 status: COMPLETE.** Wave 8 (T13 — Profile/Policy editor) remains gated on the Agent Configuration Convention spike `T-1777809840000`. If T13 slips, Wave 9 (T14 — E2E verification + WA test) can run as the v1 closeout independently.

---

### Phase 4 + Phase 5 — Group Management + Cost Tracking panels (T10 + T11 / Wave 6)

Wave 6 ships two parallel routes: `/groups` (Phase 4 — Group Management) and `/cost` (Phase 5 — Cost Tracking). Both panels share zero files, so they were built simultaneously by parallel agents after a single backend pass added the new endpoints + helpers. Recovery tags `pre-wave-6-2026-05-05` and `post-wave-6-2026-05-05` bookend the wave on origin.

**Server-side additions to `src/http/api.ts`.** Five additions, all additive:

- `POST /api/groups/:jid/enable` — mirror of the existing disable endpoint. Sets `container_config.disabled = false` and clears `deleted_at`. Audited as `group.enable`.
- `DELETE /api/groups/:jid` — soft delete (sets `disabled: true` + `deleted_at: ISO timestamp` on container_config). Preserves the SQLite row + per-group filesystem so a future "restore" surface can bring it back. Audited as `group.delete` (24h reversibility window).
- `PATCH/POST/DELETE /api/groups/:jid` — all gain optimistic-concurrency via the standard `If-Match` header (RFC-7232-style integer version). Each mutating endpoint reads `groupVersion(group)` from `container_config.version` (defaults to 0), compares to the supplied `If-Match`, returns 409 with `{ error, current_version }` on mismatch, and bumps the version on success. Helpers (`groupVersion`, `checkIfMatch`, `bumpVersion`) live alongside the route handlers. The audit/undo handler also gains `group.delete` to its restore whitelist.
- `POST /api/cost/test-alert` — drops a synthetic `[cost-alert · TEST]` message into the main group's IPC input via the existing `injectIpcMessage()` helper. Body: `{ threshold_pct, spent_cents, budget_cents }`. Audited as `test_message.send`. The dashboard's "Send test alert" button uses this; the auto-fire-on-real-threshold-breach loop is a v1.5 host-side scheduler addition.

**Dashboard mutating helpers (`dashboard/src/lib/nanoclaw.ts`).** Six new fetchers + three pure helpers, all using a shared `send()` internal that auto-attaches `If-Match`:

- `patchGroup(jid, body, version)`, `disableGroup(jid, version)`, `enableGroup(jid, version)`, `deleteGroup(jid, version)` — write paths
- `postCostTestAlert(body)` — cost test trigger
- `groupVersionOf(group)`, `isGroupDeleted(group)`, `isGroupDisabled(group)` — pure container_config inspectors

**T10 — Group Management (`T-1778242000000`).** Six new dashboard files plus two route shells (split into server `page.tsx` + sibling client view per the existing pattern):

- `app/groups/page.tsx` + `GroupListView.tsx` — `/groups` list. Polls every 5s. Renders `GroupListTable`.
- `app/groups/[jid]/page.tsx` + `GroupDetailView.tsx` — `/groups/:jid` detail. Polls every 10s. Tab strip: Overview / Activity / Configuration. The Activity tab embeds the existing `ActivityRow` filtered to the group; the Configuration tab renders the editor. `generateStaticParams() => [{ jid: '_' }]` is the static-export workaround (Next 16 + `output: 'export'` rejects unconstrained dynamic params); the placeholder JID `_` is detected client-side and shows "open a group from the list" instead of fetching.
- `panels/GroupListTable.tsx` — sortable/filterable table with Channel + Profile dropdowns and a name/folder/jid search input. Soft-deleted groups hidden by default with a "Show N deleted" toggle.
- `panels/GroupDetailHeader.tsx` — identity card with badges (Profile / Channel / Main / Disabled / Soft-deleted / Trigger-required) and `formatRelativeTime(added_at)`.
- `panels/GroupConfigEditor.tsx` — model dropdown + `requires_trigger` toggle + openMode sub-form (main only). Save → `patchGroup` with `If-Match`. On 409: inline banner + parent re-fetch. Delete + Disable buttons trigger typed-confirm dialogs; Disable starts a 60-second cooldown countdown before Re-enable becomes clickable. Spend-cap-reduction preview note when openMode budget is reduced.
- `panels/ConfirmDialog.tsx` — typed-confirm primitive shared with the Restart Stack action coming in Wave 7. Built on the existing `Dialog` primitive. Confirm button gates on `input === confirmText`; optional `destructive` flag swaps to red accent.

**T11 — Cost Tracking (`T-1778243000000`).** Five new dashboard files plus the `/cost` route shell:

- `app/cost/page.tsx` + `CostView.tsx` — `/cost` route. Polls 7-day cost (30s), 30-day cost (60s), groups (60s). Computes today's totals client-side, derives the budget from the main group's `container_config.costAlerts.dailyBudgetCents`. CSV + JSON export buttons (data: URLs, dated filenames).
- `panels/CostHeroStat.tsx` — today's spend big-number + 7-day SVG sparkline. Budget-aware percent label colored green ≤50% / amber 50–80% / red >80%. Today's column marked with a small dot at the right end of the sparkline.
- `panels/CostByModelChart.tsx` — recharts stacked-bar (`BarChart` + per-model `<Bar stackId="cost">`). Days × cents × model. Stable model colors: haiku teal, sonnet purple (--color-accent-secondary), opus orange (--color-accent), fallback grey. Custom tooltip with currency formatting + total. Empty-state explains the Wave 2 telemetry start moment.
- `panels/CostByGroupTable.tsx` — fetches up to 5000 turns from the last 30 days, rolls up per-`group_folder` totals for today / 7d / 30d / top model. Sorted by 30-day spend DESC.
- `panels/CostAlertsConfig.tsx` — daily-budget input (USD, stored as cents), 50/80/100% threshold checkboxes, Save (PATCH main group's `container_config.costAlerts` with `If-Match`), Send-test-alert button (POSTs to the new endpoint with current form values). Inline ok/error feedback. Footnote: "v1 fires on test only; auto-trigger on real threshold breach lands in v1.5."

**Nav update.** `dashboard/src/components/layout/NavLinks.tsx` extended with Groups + Cost links so all four routes are first-class. Footer version note implicit ("Wave 5 · v0.1.0" carried over from Wave 5 — kept as-is to avoid bikeshedding wave-counter UX every wave).

**Pre-deploy + restart.** Standard discipline: lsof :7842 confirmed Ben's PID 28811, creds backed up to `creds.json.pre-wave-6-2026-05-05.bak`, recovery tag pushed, `bootout`/`bootstrap` cycle. New PID 56663 came up clean. The cost-test-alert endpoint dropped a clearly-labelled test artifact into Don's GGA IPC input during verification; the artifact was deleted before the container's next run could replay it (operator-side behaviour: when the operator clicks "Send test alert" themselves, they expect the WhatsApp message to arrive — that's the wiring being verified).

**Live verification (post-restart, PID 56663).** All endpoints return 200: existing five + new `/api/cost/test-alert`. `PATCH /api/groups/:jid` with `If-Match: 999` (stale) returns 409 (optimistic concurrency confirmed). All four dashboard routes return 200: `/`, `/activity`, `/groups`, `/cost`. Static export generated 7 routes total (`/`, `/_not-found`, `/activity`, `/cost`, `/groups`, `/groups/[jid]`, `/groups/_`).

**Convention check.** Pure additive: 5 new endpoint paths (3 group action + 1 cost test + DELETE on existing path), 9 new dashboard helpers, 11 new dashboard components, 2 new route shells with split client views, no orchestrator process changes. `container_config` JSON pattern preserved throughout — every group mutation merges keys additively and never replaces wholesale; the `version` key is server-monotonic (operator-supplied versions are dropped from the merge to prevent rollback attacks). No Sensitive-functionality-list touch.

**Brain tickets.** `T-1778242000000` (T10) and `T-1778243000000` (T11) flipped to `col_done`. Epic `T-1778232000000` checkpoint updated.

**Phase 4 + Phase 5 status: COMPLETE.** Wave 7 (T12 — Phase 6 Alerts panel + audit_log + Restart Stack, 14h) is now unblocked. Wave 8 (T13 — Profile editor) remains gated on T-1777809840000 (Agent Configuration Convention spike).

---

### Phase 3 — Container Activity + Activity Log panels (T9 / Wave 5)

Wave 5 lands the dashboard's second route: `/activity`. Time-series feed of per-turn telemetry from `agent_turns` (Wave 2), polled every 3s, with filters / per-row expand / daily rollup rail / message search / CSV export. Two small server-side additions support the panel's UX features. Recovery tags `pre-wave-5-2026-05-05` and `post-wave-5-2026-05-05` bookend the wave on origin.

**Server-side additions to `src/http/api.ts`.**

- `GET /api/turns?format=csv` — returns `text/csv; charset=utf-8` with `Content-Disposition: attachment; filename="agent-turns-{date}.csv"`. Stable column order across 19 columns (started_at, group_folder, model, agent_profile, outcome, durations, token breakdown, cost, tool counts, retries, compactions, identity). Higher row cap (5000 vs the JSON path's 500) since it's an operator-driven download.
- `GET /api/turns` extended with `model=` and `outcome=` filters. The dashboard's filter bar composes group + model + outcome + since simultaneously, all server-side.
- `GET /api/messages/search?q=&group=&limit=` — full-text-ish search via SQLite `LIKE` over the `messages` table content column. Two-character minimum query length to avoid huge result sets. Returns `{messages: [...]}` with `id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message`. Verified live: searching "Ben" returns recent group messages.

**Dashboard panel components.** Activity composes a filter bar + daily rollup rail + a CSV export button + an expandable per-turn feed. New files under `dashboard/src/components/panels/`:

- `ActivityFeed.tsx` — top-level panel, owns three `usePoll` lifecycles (turns at 3s, cost daily at 30s, groups at 60s) plus a debounced (300ms) message-search effect. URL state is the single source of truth for filters via `useSearchParams` + `router.replace()` so operators can bookmark / share queries (e.g. `/activity?group=GGA&model=claude-haiku-4-5-20251001&outcome=error`)
- `ActivityRow.tsx` — single feed row. Compact summary: timestamp · group · model · tokens · cost · duration · outcome badge. Click expands to a 4-column stat grid: Tokens (input/output/cache create/cache read/total), Timing (started/finished/duration/api duration/TTFT), Reliability (tool calls/tool errors/retries/compactions/SDK turns), Identity (turn_id/session_id/agent_profile/machine_id, plus error_class when present). Plus a footer row with prompt/response char counts and a placeholder for raw container log linkout (deferred to v1.5)
- `ActivityFilters.tsx` — filter bar with group select, model select (auto-derived from observed turns + fallback to known v1 models), outcome select, time-range pill switcher (1h / 24h / 7d / All), search input. "Clear filters" link appears only when something differs from defaults
- `DailyRollupRail.tsx` — left-rail per-day summary (turn count + total cents) aggregated client-side from `/api/cost/daily`. Click a day to filter the feed to that day; click again to clear. Empty state explains that telemetry capture started with the Wave 2 deploy

**Dashboard infrastructure additions.**

- `dashboard/src/lib/nanoclaw.ts` — `Turn` interface extended to mirror the full `AgentTurnRow` schema (30 columns); previous interface had only 10 columns and was missing the per-row-expand fields the ticket calls for. New `MessageHit` interface for the search results. New `searchMessages()` and `turnsCsvUrl()` helpers
- `dashboard/src/app/activity/page.tsx` — new route, wraps `<ActivityFeed />` in `<Suspense>` (Next 16 requires this when a child uses `useSearchParams()` under static export)
- `dashboard/src/components/layout/NavLinks.tsx` — new sticky-nav link list using `next/link` + `usePathname()` for active-state styling. Links: Server Health (`/`) + Activity (`/activity`)
- `AppShell.tsx` updated to include `<NavLinks />`. Footer version note bumped to "Wave 5 · v0.1.0"

**Endpoint verification (post-restart).** All endpoints return 200: `/health`, `/api/groups`, `/api/turns?limit=5`, `/api/cost/daily`, `/api/audit`, `/api/tasks`, new `/api/messages/search?q=Ben` (2 real hits), CSV export with proper headers and 19-column header row. Dashboard `/` renders Server Health, `/activity` renders the new panel. Live state: PID 28811, Ben unchanged.

**Empty-state handling.** `agent_turns` and the cost rollup are both empty until the next real GGA reply lands (wire-up was Wave 2). The feed's empty-state message explains this. The first agent reply will populate the feed within 5 seconds (3s poll + capture latency).

**Convention check.** Pure additive — two new orchestrator endpoints (CSV format on existing `/api/turns`, new `/api/messages/search`), one extended interface (`Turn` mirrors backend), six new dashboard components, one new route. No Sensitive-functionality-list touch. Rollback path: revert `src/http/api.ts`, revert `dashboard/src/lib/nanoclaw.ts`, delete `dashboard/src/app/activity/`, delete the new panel components, restore `AppShell.tsx`.

**Brain ticket.** `T-1778241000000` (T9) flipped to `col_done`. Epic `T-1778232000000` checkpoint updated.

**Phase 3 status: COMPLETE.** Wave 6 splits into two parallel tracks: T10 (Group Management panel, 12h) + T11 (Cost Tracking panel, 8h). Both depend only on already-shipped pieces (`/api/groups`, `/api/cost/daily`, `/api/audit/:id/undo`).

---

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
