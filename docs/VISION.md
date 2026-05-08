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
| **Today** | Claude API only, via the OneCLI gateway. Provider/model selection is implicit (the OneCLI secret routes everything to Anthropic). `add-ollama-tool` is a precursor — local models are an MCP-callable *tool*, not yet a backend swap. |
| **Target** | Pluggable LLM provider per deployment (and eventually per group): Anthropic, OpenAI, Google, local Ollama, vLLM, llama.cpp. The orchestrator's container runner consumes whichever model the operator picked at setup; OneCLI either grows multi-provider routing or gets fronted by a thin adapter that does. |
| **Why** | Cost, privacy, sovereignty, ecosystem hedge. A non-technical operator who's nervous about cloud LLMs should be able to run everything against a local 70B model with one toggle. |
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
| **Today** | `npm run claw-setup` runs the CLI wizard. Doctor is a signed/notarised `.dmg` that auto-updates, but the orchestrator + dashboard + claw-setup wizard ship via "fork-and-modify" (`git pull && npm run build` — see Pull Updates in v0.1.8 for the mitigation). Operators must already have Node, Docker, Tailscale, and OneCLI installed. |
| **Target** | A single signed `.dmg` (or equivalent) installs everything: orchestrator, dashboard, claw-setup, sandbox runtime. The wizard runs **inside the app**, not in Terminal. Dependencies (Docker / Apple Container / Tailscale / OneCLI / Node) are probed and offered as one-click installs (or bundled where licensing allows). The Doctor's "Set up NanoClaw…" flow + `scripts/install-doctor.sh` are the seeds. v0.1.8's "Pull upstream updates…" closes the half of this gap that operates *after* install. |
| **Why** | Every Terminal step is a future product debt and a churn risk. The vision doesn't ask non-technical users to learn `npm`. |
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
| Phase 3 (planned) | Multi-deployment federation (v2) | 3 |
| Phase 4 (planned) | Multi-tenant boundary (v3) — segment-admin tier, tenant isolation | 3, 5 |
| Future | Pluggable LLM providers (`add-ollama-tool` is a precursor) | 1 |
| Future | Bundled-runtime app wrapper | 4, 5 |

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
