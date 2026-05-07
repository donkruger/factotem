# NanoClaw Dashboard — Solution Design

Forward-looking design for a desktop dashboard that surfaces NanoClaw's agentic state through a minimalist, multi-pane terminal UI. Drafted 2026-04-25. Status: proposal awaiting prototype.

---

## 1. Why this exists

Operating Ben today is a shell-archaeology exercise. Every incident this month has the same shape: something failed silently, the host-side state was perfectly visible if you knew which file to `tail`, but there was no surface that aggregated it. Three concrete examples that motivate this design:

- **`2026-04-24-oauth-watcher-tcc-fix.md`** — the `com.nanoclaw.oauth-refresh` watcher had `runs=373, last exit=0` (textbook green) for ~2 h while every tick silently no-op'd because of a TCC permission failure. Discovery required `launchctl print` plus `head -1` on the marker file under launchd context. A dashboard with a "watcher last tick: 2 h ago" tile would have caught it in minutes.
- **`2026-04-25-api-key-billing-block-after-oauth-rejection-windows.md`** — Anthropic transiently rejected an unchanged OAuth token for 37 minutes. Ben replied `Invalid API key · Fix external API key` to live GGA users. The watcher detected and rotated correctly every 60s; we just had no eye on it. A live "auth probe" tile would have shown rotation churn the moment it started.
- **`2026-04-17-ghost-tickets.md`** — Ben claimed two tickets were created; they didn't exist on disk. Project CLAUDE.md now mandates "verify before claiming success." A dashboard that shows tool-call evidence inline with each agent claim mechanises that policy instead of relying on an operator to remember it.

The pattern across these is the same: **observability is a product feature, not a debug affordance**. We've been re-learning this through outages. The dashboard is the place that lesson lives.

## 2. Use cases

| Today | Tomorrow | Distribution |
|---|---|---|
| Don orchestrates one Ben on his Mac. Wants a single window that replaces six tail-f's, two `launchctl print`s, and one `set-auth-mode.sh status`. | Don (or Don's customers) orchestrate multiple agents — multiple Bens on one host, or remote agents over SSH — from the same dashboard. | Ship as a notarised .dmg to non-engineer operators. They install, log in, and see green/red. They never open Terminal.app. |

The single-agent dashboard must not paint itself into a corner that makes the multi-agent extension a rewrite. The architecture below makes "agent target" a first-class abstraction so panes can be repointed without code changes.

## 3. Tech stack — recommendation

| Layer | Pick | License | Why |
|---|---|---|---|
| Shell | **Electron 38** | MIT | First-class Node + TS in the renderer; only credible host for a multi-pane terminal app at this scope (Tauri 2's PTY ecosystem is community-grade, Wails v3 is alpha, Neutralino has no PTY). |
| Terminal core | **`@xterm/xterm` 6.0** + `@xterm/addon-webgl` + `@xterm/addon-fit` | MIT | The standard. WebGL addon has a documented GPU-memory leak unless `dispose()` is called on pane teardown — discipline this in the pane lifecycle. |
| PTY | **node-pty 1.1.0** (or 1.2.0-beta when GA) | MIT | Microsoft's. Native module — must be rebuilt per Electron ABI; ship prebuilds via `electron-builder`. Isolate in a **utility process** modeled on VS Code's Pty Host so 100 MB of agent output cannot block the UI thread. |
| Layout | **react-resizable-panels 4.9** | MIT | Brian Vaughn (ex-React core). Keyboard-a11y, persisted layouts, group/panel model. Allotment is the runner-up if we want VS-Code-style nested splitters. react-mosaic (Apache 2.0) only if users will rearrange tabs. |
| State | **Zustand** in renderer + main-process event broker over `contextBridge` | MIT | No off-the-shelf "tiled terminals + shared live state" lib exists; this is the VS Code pattern. Health state owned by the utility process, broadcast as deltas — survives renderer reload. |
| Agent runtime | **`@anthropic-ai/claude-agent-sdk`** ≥ 0.2.111 (TypeScript) | Anthropic Commercial Terms | In-process `query()` async iterator per pane. Pipe-mode JSON, not PTY (despite the visual being a terminal). Lets us own the rendering pipeline and inject verification evidence per tool call. |
| Bridge between panes ↔ host state | **MCP HTTP servers** running inside the Electron main process | MIT (per MCP spec) | Each Claude session calls `mcp__pane-monitor__*` tools to get authoritative host data instead of asking the model to invent it. Decouples agent prompts from Electron internals and lets multiple panes share the same data without copying. |
| Packaging | **electron-builder** + **electron-updater 6.8** | MIT | Mature; supports staged rollouts and signature validation. Avoids the Mac App Store sandbox, which would kill any pane that spawns `claude`. |
| Code signing | Apple Developer ID + `electron/notarize` | (Apple, $99/yr) | Hardened Runtime mandatory; entitlements `com.apple.security.cs.allow-jit` (and pre-Electron-11 `allow-unsigned-executable-memory`). Notarization via `notarytool`. |

## 4. Build vs fork — **Fork Wave Terminal**

Wave Terminal (`wavetermdev/waveterm`, Apache-2.0, 19.9 k stars, weekly release cadence, commercial backer) is the only project in the OSS terminal landscape that satisfies all four hard constraints simultaneously: permissive license, native multi-pane block model, AI-native by default, active maintenance. The "1 chat + 3 monitors" layout *is* their drag-and-drop block primitive — no retrofit. Wave already speaks Claude over BYO-key; the integration point is replacing their HTTP client with a `claude-agent-sdk` adapter that targets OneCLI at `http://127.0.0.1:10254`.

Greenfield is rejected:
- **Hyper** (MIT, 44 k stars) — last release January 2023, abandoned.
- **Tabby** (MIT, 70 k stars) — single maintainer, over-indexed on SSH, no AI primitives.
- **Alacritty / WezTerm** (Apache + MIT) — native renderers that *explicitly* reject tabs/splits and have no web-pane story.
- **opcode** (ex-Claudia, AGPL-3.0) — license disqualifies productisation.
- **Cline** (Apache 2.0) — VS Code extension, not standalone.

Fork plan: `wavetermdev/waveterm` → `donkruger/factotem-dashboard`. Replace Wave AI's HTTP client. Pre-configure the default workspace as the four-block layout below. Track upstream weekly to avoid divergence drift; rebase rather than long-lived branches.

Three patterns to steal from outside Wave:
1. **Warp's command palette + command blocks** — every agent action grouped with its tool-call evidence inline. Directly addresses the ghost-tickets failure mode.
2. **Cline's per-action approval + checkpoint snapshots** — every tool call shows a diff/preview before commit, with rollback. Pairs mechanically with the project's `verify before claiming success` rule.
3. **VS Code's Pty Host isolation** — node-pty out of the renderer, headless `@xterm/headless` mirror for scrollback. Required for stability with 4+ live panes.

## 5. Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                      Electron Main Process                            │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │  Pane Registry  ◄──►  MCP HTTP Server (localhost:RAND)       │   │
│  │  Session Store  ◄──►  Agent Target Registry                  │   │
│  │  Health Bus     ◄──►  Update Channel (electron-updater)      │   │
│  └────────┬─────────────────────────────────────┬────────────────┘  │
│           │                                     │                     │
│   ┌───────▼──────┐                     ┌────────▼────────┐           │
│   │  Pty Host    │                     │  Agent Runner   │           │
│   │  (utility)   │                     │  (utility)      │           │
│   │  node-pty    │                     │  claude-agent-  │           │
│   │  @xterm/     │                     │  sdk query()    │           │
│   │  headless    │                     │  per pane       │           │
│   └───────┬──────┘                     └────────┬────────┘           │
│           │                                     │                     │
│           └────────── MessagePort IPC ──────────┘                     │
│                              │                                        │
│              contextBridge   ▼                                        │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │                Renderer (React + Zustand + Vite)              │   │
│  │  ┌────────────────────┬───────────────────────────────────┐  │   │
│  │  │  Pane 1: Chat       │  Pane 2: Service health          │  │   │
│  │  │  (xterm.js + agent  │  (auth probe, OneCLI, launchd)   │  │   │
│  │  │   SDK pipe)         │                                  │  │   │
│  │  ├─────────────────────┼──────────────────────────────────┤  │   │
│  │  │  Pane 3: Auth/creds │  Pane 4: Conversation health     │  │   │
│  │  │  (watcher, rotations│  (recent turns, latency, errors) │  │   │
│  │  │   token freshness)  │                                  │  │   │
│  │  └─────────────────────┴──────────────────────────────────┘  │   │
│  │  Command palette (⌘K) · Block toolbar · Status bar           │   │
│  └──────────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────────┘
                              │
                  spawns/probes Ben on the host
                  (launchd, docker, OneCLI, ~/.config/nanoclaw/auth-mode,
                   /tmp/nanoclaw-oauth-refresh.health, nanoclaw/logs/*)
```

**Pane lifecycle.** A pane = `{ id, agentTarget, sessionId, blockType, config }`. On creation, the main-process Pane Registry mints a sessionId and (depending on `blockType`) either spawns a real PTY for that pane (xterm.js + node-pty in Pty Host) or starts an `@anthropic-ai/claude-agent-sdk` `query()` iterator in the Agent Runner utility process. The visual chrome is identical: dark pane with a 32-px header, monospace stream below. The transport is hidden.

**MCP as the bridge.** The main process registers an MCP HTTP server exposing tools like `pane-monitor.get_service_health()`, `pane-monitor.get_auth_probe()`, `pane-monitor.tail_log(path)`. Health-monitor panes' Claude sessions are configured with `allowedTools: ['mcp__pane-monitor__*']` so the agent doesn't have to invent state — it queries authoritative host data. This addresses both the ghost-tickets failure mode (model can't claim a thing happened it didn't observe) and the multi-agent extension (other agents on other hosts have their own MCP server; pane just points elsewhere).

**Health bus.** A simple pub/sub in main; the Pty Host and Agent Runner publish `bus.publish('health.auth', 'probe-reject')` etc.; subscriber panes refresh. Survives renderer reload because state is in main.

**Persistence.** Per `claude-agent-sdk` docs, sessions live at `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`. Dashboard's session store persists `(paneId → sessionId)` mappings in `~/.config/nanoclaw-dashboard/sessions.json` and uses `--resume` on relaunch to restore conversations.

## 6. The three default health panes

Each pane is a Claude Code session whose system prompt + tool set define its job. The agent decides what to surface and how — the dashboard supplies authoritative data via MCP and renders the agent's stream in xterm.js.

| Pane | Purpose | MCP tools | Update model | Would have caught… |
|---|---|---|---|---|
| **Service health** | NanoClaw + OneCLI + Docker liveness | `pane-monitor.launchd_state`, `pane-monitor.docker_ps`, `pane-monitor.onecli_ping` | 30s poll + `fs.watch` on `nanoclaw.log` for fresh ERROR lines | The 2026-04-24 OneCLI-down-after-host-reboot incident (NanoClaw said "running" while OneCLI was Exited(0)). |
| **Auth & credentials** | Auth-mode marker, watcher freshness, live API probe | `pane-monitor.auth_mode`, `pane-monitor.watcher_health` (reads `/tmp/nanoclaw-oauth-refresh.health` mtime), `pane-monitor.anthropic_probe` | `fs.watch` on the health file (mtime-driven, sub-second), 60s active probe | The 2 h silent TCC failure (2026-04-24); the 37 min Anthropic-side rejection window (2026-04-25). |
| **Conversation health** | Per-group activity: last successful turn, latency, retry storms | `pane-monitor.tail_log('nanoclaw.log')`, `pane-monitor.recent_container_results` | log-tail event stream | The 18:42 ghost-DM and 19:01 "Invalid API key" bursts; would have flagged the rejection storm in the first minute. |

Each pane's Claude session uses an `--append-system-prompt` template ("you are the auth-monitor, summarise the last minute, surface anomalies, never invent state — call MCP tools for everything") that an operator can edit. Repurposing a pane is editing its system prompt and tool list; no rebuild.

The fourth pane is **Pane 1: blank-canvas chat**. Plain `query()` against the user's default credential, with the project workspace as `cwd`. Behaves identically to `claude` in a normal terminal.

## 7. Multi-agent extension

The single load-bearing abstraction: **agent target**. A pane is bound to one target. Targets:

```ts
type AgentTarget =
  | { kind: 'local-claude' }                                  // single-agent today
  | { kind: 'local-mcp', endpoint: string }                   // a sibling Ben on this host
  | { kind: 'remote-mcp', sshHost: string, endpoint: string } // another operator's Ben over SSH-tunneled MCP
  | { kind: 'managed', tenantId: string, jwt: string }        // future SaaS
```

Single-agent today: every pane uses `local-claude`. Multi-agent later: an operator can run `New Workspace → New Pane → Target: don-laptop-ben`, the same UI primitives, different session backend. The MCP server abstraction means the host data the agent sees is provenance-correct for *that* target — no cross-contamination.

Implications today:
- Build the target switcher into the pane chrome from day one (a dropdown, even if it has one option). It's cheaper than retrofitting.
- The Pane Registry, Session Store, and Health Bus must key on `(paneId, target)` not `paneId`. Five extra lines now versus a refactor later.

## 8. UI / UX

Aesthetic direction: minimalist dark. Pane chrome is one row at the top — block type icon, live status dot (green/amber/red), block title, ⋮ menu. No tab bars per pane. Layout uses react-resizable-panels with a 2×2 default; users can collapse/restore panes from the command palette.

- **Font stack:** `'JetBrains Mono', 'Berkeley Mono', 'IBM Plex Mono', ui-monospace, monospace`.
- **Theme:** xterm.js theme constructed from a small palette (`bg #0a0a0c`, `fg #e5e5ea`, accent `#7aa2f7` blue, error `#f7768e`, success `#9ece6a`). Match the macOS native dark vibe but dim further for a content-first feel.
- **Command palette (⌘K):** every action surfaces here — switch agent target, restart Ben, run set-auth-mode, repurpose pane, export session log. Stolen from Warp.
- **Pane zero-state:** instead of "no output yet," show the pane's system prompt + the MCP tools it has access to. Communicates what the pane *will* do before it does it.
- **Verification chips:** every tool call the agent makes renders as a chip under its message — `✓ docker_ps (12ms)` or `✗ launchd_state failed: Operation not permitted` — clickable to expand the raw response. This is the productisation of the project's verify-before-claiming rule.

## 9. Distribution at scale

- **Channel:** GitHub Releases as the artifact host (electron-updater supports it natively); .dmg for macOS, .AppImage and .deb for Linux later.
- **Updates:** `electron-updater 6.8` with staged rollouts (10 % → 50 % → 100 %) and signature validation. Auto-update opt-in by default, auto-download in the background.
- **Signing:** Apple Developer ID ($99/yr flat). Hardened Runtime + `electron/notarize` via `notarytool`. **No Mac App Store** — the sandbox kills child-process spawning of `claude` and any agent tool that touches the user's filesystem.
- **Telemetry:** opt-in; never on by default. If enabled, ship only health-tile transitions (`auth.green → auth.amber`) — never user prompts, never Claude responses.
- **Privacy posture:** no LLM traffic ever flows through dashboard servers. The dashboard is a UI shell; all agent traffic is operator's keys, operator's machine, operator's Anthropic account.

## 10. Risks and open questions

- **Subscription OAuth concurrency.** Yesterday's 37 min Anthropic-side rejection window was almost certainly multi-process subscription contention. **The dashboard must require API-key auth, not OAuth-via-claude.ai.** Documented as a hard prereq in onboarding.
- **`claude` CLI version drift.** Users may upgrade their `claude` CLI underneath us; the SDK version may diverge from the bundled one. Pin via `package.json` and detect/warn on mismatch at startup.
- **node-pty ABI rebuilds.** Every Electron-version bump requires rebuilding native modules. CI must produce per-platform prebuilds; ship them in the .dmg.
- **Wave Terminal upstream pace.** Weekly release cadence is mostly a benefit but increases rebase cost. Decision: rebase weekly; never long-lived feature branches.
- **MCP inside Electron — security boundary.** The MCP server is loopback-only, but ANY local process can hit it. Add an auth token negotiated between main and the spawned agent at session start.
- **Multi-agent auth scope.** When a pane targets a remote agent, whose key signs the requests? Probably the operator's, via SSH-tunneled MCP — but this needs spec'ing before we ship the feature.

## 11. Recommended prototype scope (~5 working days)

A ship-or-kill bar: by end of week, **Don opens the dashboard, sees Ben's health in three live panes, and chats with Claude in the fourth — without opening Terminal.app**.

- **Day 1–2:** Fork Wave; replace Wave AI's HTTP client with a `claude-agent-sdk` adapter; verify a single Claude pane works against the user's default credentials.
- **Day 3:** Stand up the MCP server in main with the three pane-monitor tool sets; verify each tool returns expected host data via `curl` from a test client.
- **Day 4:** Pre-configure the default 2×2 workspace; wire the three monitor panes to their MCP tools; verify watcher-staleness shows red within 60s of the watcher being killed.
- **Day 5:** Polish — command palette, verification chips on tool calls, theme tuning. Build a signed-and-notarised .dmg.

Kill criteria — abandon if any of these is true at end of day 5:
1. Wave's block API can't host xterm.js + Agent SDK pipe streaming without a fork-internals rewrite.
2. The MCP-as-data-source pattern adds > 200 ms median latency to a pane's "render" tick (would kill the live-feel).
3. node-pty rebuild for the bundled Electron version isn't reproducible in CI.

If we ship, the next milestone is the multi-agent target switcher and the first non-Don user.

---

## Appendix: file-system surfaces the dashboard reads

| Surface | Path | Source of truth for |
|---|---|---|
| Auth mode marker | `~/.config/nanoclaw/auth-mode` | Current mode (`api-key` \| `oauth-workaround`) |
| Watcher health | `/tmp/nanoclaw-oauth-refresh.health` | OAuth watcher last tick + status |
| Watcher cache | `/tmp/nanoclaw-oauth-last-pushed` | Last token pushed to OneCLI |
| NanoClaw service | `launchctl print gui/<uid>/com.nanoclaw` | Process PID, etime, last exit |
| OneCLI gateway | `http://127.0.0.1:10254/health` | Vault liveness |
| Containers | `docker ps --filter name=nanoclaw-` | Active per-group containers |
| Logs | `nanoclaw/logs/nanoclaw.log`, `nanoclaw.error.log`, per-group `groups/*/logs/container-*.log` | Conversation timeline, errors |
| Per-group state | `groups/<name>/CLAUDE.md`, `data/sessions/<group>/` | Group-isolated agent memory |
| Auth probe | The probe block in `scripts/set-auth-mode.sh` (lines 65–83) | Live Anthropic accept/reject |

Each maps to one or more MCP tools on the dashboard side; none requires the operator to remember the path.
