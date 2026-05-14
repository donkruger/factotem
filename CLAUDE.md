# NanoClaw

Personal Claude assistant — operator-facing brand **Factotem**, orchestrator primitive **NanoClaw** (fork: `donkruger/factotem`, originally forked as `donkruger/benclaw`).

- [docs/VISION.md](docs/VISION.md) — **Long-run trajectory**: five pillars (model agnosticism, human-readable UX, multi-machine fleet over Tailscale, wizard-as-app-wrapper, radical simplification) + non-goals. **Read this before proposing any non-trivial change** — does it move us toward the vision or away from it?
- [docs/ui-ux-direction.md](docs/ui-ux-direction.md) — **The three user-facing surfaces** (CLI wizard, GUI wizard, dashboard) and the hand-off rules between them. **Read this before changing anything visible** — colour tokens, wizard flow, dashboard layout, anything an operator sees.
- [docs/DEPLOYMENT_CONVENTIONS.md](docs/DEPLOYMENT_CONVENTIONS.md) — **5-minute deployment briefing**: two-repo setup, five-file version bump, tag namespace, what NOT to do, verification commands. **Read this before cutting a release or designing a change that affects how operators receive updates.**
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — Full current-state architecture, message flow, security model
- [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) — Philosophy and design decisions
- [docs/SPEC.md](docs/SPEC.md) — Detailed specification
- [docs/OPERATIONS.md](docs/OPERATIONS.md) — Startup, recovery, troubleshooting runbook
- [docs/CHANGE_LOG.md](docs/CHANGE_LOG.md) — Timestamped change history
- [.cursor/rules/development_conventions.mdc](.cursor/rules/development_conventions.mdc) — Development conventions

## Quick Context

Single Node.js process with skill-based channel system. Channels (WhatsApp, Telegram, Slack, Discord, Gmail) are skills that self-register at startup. Messages route to Claude Agent SDK running in containers (Linux VMs). Each group has isolated filesystem and memory.

**Vision-check before non-trivial work:** the project is heading toward LLM model agnosticism, human-readable UX everywhere, multi-machine fleet orchestration over Tailscale, and a single-download app-wrapper installer — all in service of non-technical operators running their own agentic workforce on owned hardware. Every CLI step we add is a future product debt; every error message in raw stderr is a UX failure. See [docs/VISION.md](docs/VISION.md) for the full pillars + non-goals.

**The three operator-facing surfaces** are the CLI wizard at `cli/claw-setup/` (headless / SRE path), the GUI wizard at `cli/claw-setup-gui/` (download-and-double-click installer), and the dashboard at `dashboard/` (post-setup home). They share a state file and a design system; the GUI hands off to the dashboard on completion. See [docs/ui-ux-direction.md](docs/ui-ux-direction.md) before touching anything visible, and `cli/claw-setup-gui/CLAUDE.md` for GUI-specific rules.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Orchestrator: state, message loop, agent invocation |
| `src/channels/registry.ts` | Channel registry (self-registration at startup) |
| `src/ipc.ts` | IPC watcher and task processing |
| `src/router.ts` | Message formatting and outbound routing |
| `src/config.ts` | Trigger pattern, paths, intervals |
| `src/container-runner.ts` | Spawns agent containers with mounts |
| `src/task-scheduler.ts` | Runs scheduled tasks |
| `src/db.ts` | SQLite operations |
| `groups/{name}/CLAUDE.md` | Per-group memory (isolated) |
| `container/skills/` | Skills loaded inside agent containers (browser, status, formatting) |
| `src/skills/x-handler.ts` | Host-side IPC handler for X (Twitter) integration |
| `container/skills/excel-reader/` | Excel/CSV extraction CLI for container agents |

## Secrets / Credentials / Proxy (OneCLI)

API keys, secret keys, OAuth tokens, and auth credentials are managed by the OneCLI gateway — which handles secret injection into containers at request time, so no keys or tokens are ever passed to containers directly. Run `onecli --help`.

**Auth mode:** the Anthropic credential in OneCLI can be a stable API key (`sk-ant-api...`) or a rotating subscription OAuth token (`sk-ant-oat01-...`). Current mode is recorded in `~/.config/nanoclaw/auth-mode` (outside Documents/ so the launchd-spawned oauth watcher can read it past macOS TCC); switch with `scripts/set-auth-mode.sh {status|api-key --value ...|oauth-workaround}`. OAuth mode additionally runs a launchd watcher (`com.nanoclaw.oauth-refresh`) that re-syncs OneCLI from the keychain on each rotation and writes its last tick to `/tmp/nanoclaw-oauth-refresh.health` (also surfaced in `set-auth-mode.sh status`). See `docs/OPERATIONS.md` § Auth Mode.

## Skills

Four types of skills exist in NanoClaw. See [CONTRIBUTING.md](CONTRIBUTING.md) for the full taxonomy and guidelines.

- **Feature skills** — merge a `skill/*` branch to add capabilities (e.g. `/add-telegram`, `/add-slack`)
- **Utility skills** — ship code files alongside SKILL.md (e.g. `/claw`)
- **Operational skills** — instruction-only workflows, always on `main` (e.g. `/setup`, `/debug`)
- **Container skills** — loaded inside agent containers at runtime (`container/skills/`)

| Skill | When to Use |
|-------|-------------|
| `/setup` | First-time installation, authentication, service configuration |
| `/customize` | Adding channels, integrations, changing behavior |
| `/debug` | Container issues, logs, troubleshooting |
| `/update-nanoclaw` | Bring upstream NanoClaw updates into a customized install |
| `/qodo-pr-resolver` | Fetch and fix Qodo PR review issues interactively or in batch |
| `/get-qodo-rules` | Load org- and repo-level coding rules from Qodo before code tasks |

## Contributing

Before creating a PR, adding a skill, or preparing any contribution, you MUST read [CONTRIBUTING.md](CONTRIBUTING.md). It covers accepted change types, the four skill types and their guidelines, SKILL.md format rules, PR requirements, and the pre-submission checklist (searching for existing PRs/issues, testing, description format).

## Development

Run commands directly—don't tell the user to run them.

```bash
npm run dev          # Run with hot reload
npm run build        # Compile TypeScript
./container/build.sh # Rebuild agent container
```

Service management:
```bash
# macOS (launchd)
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # restart

# Linux (systemd)
systemctl --user start nanoclaw
systemctl --user stop nanoclaw
systemctl --user restart nanoclaw
```

## Troubleshooting

**`spawn npx ENOENT` or exit code 127 from host-side skills:** The launchd service runs with a minimal PATH that does not include `/opt/homebrew/bin`. Never use bare `npx`/`tsx`/`node` or `node_modules/.bin/` stubs (they use `#!/usr/bin/env node` which also fails). Instead use `process.execPath` + the module entry point directly. See "Spawning Subprocesses on the Host" in `.cursor/rules/development_conventions.mdc`.

**WhatsApp not connecting after upgrade:** WhatsApp is now a separate skill, not bundled in core. Run `/add-whatsapp` (or `npx tsx scripts/apply-skill.ts .claude/skills/add-whatsapp && npm run build`) to install it. Existing auth credentials and groups are preserved.

## Container Build Cache

The container buildkit caches the build context aggressively. `--no-cache` alone does NOT invalidate COPY steps — the builder's volume retains stale files. To force a truly clean rebuild, prune the builder then re-run `./container/build.sh`.

## Agent-Runner Source Caching (IMPORTANT)

The agent-runner source (`container/agent-runner/src/`) is cached per-group at `data/sessions/{group}/agent-runner-src/` on first container spawn. This cached copy is mounted into containers and **overrides the baked-in image code**.

After modifying `container/agent-runner/src/`, you MUST sync cached copies:

```bash
for dir in data/sessions/*/agent-runner-src; do
  [ -d "$dir" ] && cp container/agent-runner/src/*.ts "$dir/"
done
```

**Full deployment steps for new integrations:**
1. `npm run build` — compile host TypeScript
2. `./container/build.sh` — rebuild container image
3. Sync agent-runner cache (command above)
4. `launchctl kickstart -k gui/$(id -u)/com.nanoclaw` — restart service
5. Verify agent can see new tools
