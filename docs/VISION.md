# Vision & Long-run Trajectory

> Last updated: 2026-05-08

A canonical reference for where Factotem / NanoClaw is going. Every PR, skill,
and agentic intervention should be checkable against the five pillars below —
"does this move us toward the vision, or away from it?" If you're building
something this doc doesn't recognise, that's a signal to question whether it
belongs here.

For where the project is **today** see [REQUIREMENTS.md](REQUIREMENTS.md) (philosophy
+ design decisions) and [ARCHITECTURE.md](ARCHITECTURE.md) (current-state implementation).
For what shipped when, see [CHANGE_LOG.md](CHANGE_LOG.md). This document is the
**target state** the others are walking toward.

## North star

Non-technical users spinning up their own autonomous employees on owned
hardware (Mac minis on a Tailnet), managing a personal agentic workforce
without ever opening a Terminal. The operator clicks a single signed `.dmg`,
answers four or five plain-language prompts, and starts delegating work to
agents from WhatsApp / Telegram / Slack / email — same day, no engineer needed.

Everything in this doc is in service of that picture.

## The five pillars

### 1. LLM model agnosticism

| | |
|---|---|
| **Today (2026-05-14, shipped v1.2)** | Multi-agent, multi-provider via the Gemini blueprint ([`docs/implementation/gemini-blueprint.md`](implementation/gemini-blueprint.md)). The `agents` table is the primary entity; each agent picks its protocol + model + credential from a data-driven [`setup/providers.json`](../setup/providers.json) registry. Two container images cover every cloud + local provider today: `nanoclaw-agent` (Anthropic-native) and `nanoclaw-agent-oai` (OpenAI-compatible — Gemini, OpenAI, OpenRouter, Together, Groq, Ollama, vLLM). Per-message `@<trigger>` mentions dispatch to the matching agent; the dashboard's ModelSwitchModal walks an operator through a three-screen target → capability-diff → sandbox-test journey. |
| **Target** | Adding the 9th provider stays a `providers.json` edit + an operator-facing doc. Adding a brand-new wire protocol means a new container image. Future: a meta-router that picks providers per request (cost-based or capability-based — explicitly out of scope for now per "Non-goals" below); native-feature containers for providers whose unique capabilities don't survive the OpenAI-compat layer (Gemini's grounding-with-search is the canonical example). |
| **Why** | Cost, privacy, sovereignty, ecosystem hedge. A non-technical operator who's nervous about cloud LLMs runs everything against a local 70B model in Ollama by picking it in the wizard's Provider step — no code change, no rebuild. |
| **Non-goals (v1/v2)** | A meta-router that picks providers per request. A unified embedding/RAG pipeline. Anything resembling a model marketplace. |

### 2. Human-readable UI/UX everywhere

| | |
|---|---|
| **Today** | Dashboard pages exist for groups, cost, audit, persona, alerts, activity. CLI wizard (`npm run claw-setup`) handles setup. Doctor menu-bar covers cold-start, repair, and pull-updates with typed-confirm + live-progress windows. |
| **Target** | Every operator surface is legible to a non-technical user. No raw JSON dumped on screen. No `tail -f` as a "feature". No SQLite peeks. The Repair Stack pattern (typed confirm → live per-step progress → plain-language step explanation → success/failure footer with next action) is the **template** every operator action should match. |
| **Why** | The audience is non-technical operators. UX gaps directly translate to support burden, abandonment, and bad reviews when this productises. |
| **Non-goals (v1/v2)** | Pixel-perfect design system. Accessibility for assistive tech (will arrive, but not a v1 blocker). Internationalisation. |

### 3. Multi-machine fleet orchestration over Tailscale

| | |
|---|---|
| **Today** | Single-machine deployment. Doctor's multi-instance probe sees other deployments on the LAN/Tailnet but doesn't surface them in any operator UI. The orchestrator's `/health` includes `machine.tailscale_ip` already; the data is collected, not displayed. |
| **Target** | The dashboard renders a **fleet view** across the operator's Tailnet. Per-machine health cards. Per-machine groups. Operator can move tasks between machines, designate a "main" Mac mini that owns shared groups, and see which deployment a given conversation lives on. README's Phase 3 ("Multi-deployment federation, v2") is this. |
| **Trust boundary** | Tailscale ACLs gate per-deployment access in v2 (each Mac mini is one principal on the Tailnet). v3 introduces a segment-admin permission tier so a household / small team can have one operator manage multiple operators' machines. |
| **Why** | Single-machine is the natural starting point but ceilings out fast. A real agentic workforce wants resilience (one Mac down ≠ everything down) and specialisation (this Mac does email, that Mac does calendar). |
| **Non-goals (v1/v2)** | Cloud relay. SaaS aggregation. Cross-Tailnet federation. |

### 4. Wizard → fully housed app wrapper

| | |
|---|---|
| **Today (2026-05-14, partial)** | The GUI wizard ships at `cli/claw-setup-gui/` — signed + notarised `.dmg` distributed to `RichardBNel/Factotem/releases`, drag-into-Applications install, runs the same twelve-step setup the CLI wizard does, and hands off into the Factotem dashboard *inside the same Electron window* on completion. Subsequent launches auto-skip the wizard entirely when the orchestrator is healthy. The CLI wizard (`cli/claw-setup/`) remains as the headless / SSH / CI / recovery path. Dependencies (Node, Docker, Tailscale, OneCLI) are probed in step 01; OneCLI is installed inline via `curl … \| sh` in step 03; the rest are surfaced with one-click "Open install page" links rather than bundled (licensing). Reference [`docs/ui-ux-direction.md`](ui-ux-direction.md) for the architecture. |
| **Target** | The remaining gap to "fully housed": bundle Node + a container runtime (Docker / Apple Container / podman) within the installer where licensing allows, so the operator's *first* prereq probe is green out of the box; add an in-app updater (`latest-mac.yml` is already shipped as a release artefact for this) so wizard upgrades land via a one-click banner rather than a redownload; and unify the orchestrator's `setup/*.ts` primitives + CLI step modules + GUI step modules behind a single `UI` adapter (the architectural plan in `UI-MIGRATION-FEASIBILITY.md`). |
| **Why** | Every Terminal step is a future product debt and a churn risk. The vision doesn't ask non-technical users to learn `npm`. |
| **Reference implementation** | [EasyClaw](https://github.com/ybgwon96/easyclaw) — Electron + React 19 + Tailwind 4 installer for OpenClaw (a sibling/predecessor of NanoClaw, MIT licensed). The 2026-05-14 GUI wizard ports their `runWithLog` + `useInstallLogs` + inline `<LogViewer>` patterns directly; structural choices are theirs, the design language was retuned to match the Factotem dashboard (light mode, Comfortaa wordmark, warm orange `#ff7a3a` accent). |
| **Non-goals (v1/v2)** | Mac App Store distribution (signing constraints conflict with the dependency probe). Auto-updating the orchestrator codebase on machines with local commits (Pull Updates' preflight handles this — customised forks stay safe). Bundling Docker (licensing). |

### 5. Ethos — radical simplification for non-technical operators

This pillar is the lens for the other four. It's not a deliverable; it's a
constraint we apply when choosing between options.

- **Every CLI step we expose to operators is a future product debt.** Adding
  one more "just type `npx tsx setup/index.ts --step register …`" is fine for
  v1; expect to delete it before v2.
- **Every error message in raw stderr is a UX failure.** Catch errors at the
  outermost UI layer and translate them into "here's what happened, here's
  what to do next" — the way the Doctor's Repair Stack windows do.
- **"Type these 5 commands in this order"** is a v1 affordance, not a v2 one.
  Each release should reduce the number of Terminal interactions a fresh
  operator needs.
- **Docs that read like a manual page** are a smell. Operator-facing docs
  should read like a friendly walkthrough with screenshots, not like
  `man launchctl`. (Internal docs — this one, ARCHITECTURE.md — can stay
  technical; the audience is contributors and future agents, not operators.)

## How the pillars map onto the release phases

| Phase | Ship state | Description | Pillar(s) |
|-------|------------|-------------|-----------|
| Phase 1 | ✓ shipped | Tauri Doctor menu-bar app | 2, 5 |
| Phase 2 | ✓ shipped | Release pipeline + auto-updates for the Doctor binary | 4, 5 |
| W.1 (orchestrator) | ✓ shipped | Persona configurability, open-DM, `/health` diagnostics | 2, 5 |
| v0.1.7 (orchestrator) | ✓ shipped | Persona dashboard page, real `/health` probes, version stamping | 2 |
| v0.1.8 (Doctor) | ✓ shipped | "Pull upstream updates…" tray action — closes the orchestrator-auto-update gap | 4, 5 |
| v0.1.9 (Doctor) | ✓ shipped | Per-step badge propagation fix — Pull/Repair UIs reconcile from the synchronous result so failure detail always renders | 2 |
| Wizard UX Tier 1+2 (orchestrator) | ✓ shipped | 14 copy + feedback edits across the 12-step CLI wizard — labels, heartbeats, error tails, `machine.json` backstop | 2, 5 |
| EasyClaw-inspired inline install (orchestrator) | ✓ shipped | Step 03 OneCLI install runs in the wizard's terminal instead of opening a second one. First `osascript "tell Terminal"` removed from the cold-start flow | 4, 5 |
| v0.1.10 (Doctor + orchestrator) | ✓ shipped | Pre-flight checklist in the Welcome window (probes git, node, docker, tailscale + one-click Launch Docker) and curl-bootstrap one-liner — the cold-start collapses from a multi-line `git clone … && cd … && npm` chain to a single `curl -fsSL …/bootstrap.sh \| sh` (oh-my-zsh / nvm / rustup shape). Wizard side gets Docker auto-launch (R3), Doctor-first handoff cheat-sheet (F11), and a stale-`gh`-CLI-fallback fix in `docs/SETUP_WIZARD.md` (F13). Implements R1+R2+R3+F11+F13 from `assessments/2026-05-08-setup-journey-ux.md` | 4, 5 |
| v0.1.11 (Doctor) | ✓ shipped | Hot-fix for v0.1.10 prereq probes — Doctor now lifts PATH from the operator's interactive login shell at boot (fix-path / shell-env pattern), with canonical-dir backstop (`/usr/local/bin`, `/opt/homebrew/bin`). Resolves the GUI-vs-shell PATH gap that caused the Welcome checklist to false-flag `/usr/local/bin/node` as "not installed" on every macOS host where `launchctl getenv PATH` is unset (the default). See [`ben-log/2026-05-08-doctor-prereq-gui-path.md`](../ben-log/2026-05-08-doctor-prereq-gui-path.md) for the canonical incident | 5 |
| v0.1.12 (bootstrap.sh + wizard) | ✓ shipped | Hot-fix for the v0.1.10 R2 curl-pipe one-liner. `scripts/bootstrap.sh` now re-attaches stdin to `/dev/tty` before `exec`'ing the wizard (oh-my-zsh / nvm / rustup pattern), so `@clack/prompts` reads from a real TTY instead of the closed curl pipe and the operator's keypresses actually register. Wizard side gets a defence-in-depth `process.stdin.isTTY` guard with actionable copy in `cli/claw-setup/src/index.ts`. Doctor binary unchanged from v0.1.11 except for the embedded version string — release exists to publish the updated `bootstrap.sh` to the public mirror's `/latest/download/` URL. See [`ben-log/2026-05-08-bootstrap-curl-pipe-stdin.md`](../ben-log/2026-05-08-bootstrap-curl-pipe-stdin.md) for the canonical incident | 5 |
| Phase 3 | planned | Multi-deployment federation (v2) | 3 |
| Phase 4 | planned | Multi-tenant boundary (v3) — segment-admin tier, tenant isolation | 3, 5 |
| Future | — | Pluggable LLM providers (`add-ollama-tool` is a precursor) | 1 |
| Future | — | Bundled-runtime app wrapper (Tauri GUI wizard, EasyClaw shape) | 4, 5 |

## Non-goals (v1/v2)

Explicit so contributors don't accidentally drift into them:

- Cloud backend / SaaS layer. Everything runs on operator-owned hardware.
- Centralised auth / single-sign-on. Tailscale-trust is the network boundary.
- Per-channel personas. One assistant identity per deployment in v1; multi-channel personas land with v2 federation.
- Public-facing webhooks beyond Tailscale-trust. The dashboard never gets exposed to the public internet in v1/v2.
- Replacing operators' existing Mac minis with new hardware. The point is to use what they already own.
- Anything resembling a marketplace, an app store, or a billing layer.

## When to update this doc

- Any PR that meaningfully shifts trajectory along one of the five pillars
  should update the corresponding "Today / Target" cell.
- Any PR that reveals a new non-goal (e.g., "we tried this and it doesn't
  fit") should append to the non-goals list.
- The phase-map table updates when a phase ships or a new one is named.

Keep this one source of truth. Don't fork the vision into competing docs.

## Governance for agentic interventions

If you're a Claude Code / Agent SDK session reading this — the project's
[CLAUDE.md](../CLAUDE.md) points at this doc deliberately. Use it as a check
when proposing changes:

- Does the change move us toward one of the five pillars?
- Does it accidentally violate a non-goal?
- Does it add a CLI step where a UI affordance would do?
- Does it make a future provider swap harder (locking us deeper into
  Claude-API-shaped assumptions)?

Surface the answer in your plan or PR description. "I checked VISION.md and
this is in scope of pillar 4" beats "trust me, this is fine."
