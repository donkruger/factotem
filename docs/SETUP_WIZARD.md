# Setup Wizard

Operator-facing cold-start onboarding for new NanoClaw deployments. The
wizard wraps the existing setup primitives in `setup/*.ts` with
resumability, preflight checks, and the twelve-step happy path that
takes a fresh Mac from "nothing" to "agent alive on WhatsApp" without
manual config-file editing.

## Two surfaces, same setup logic

| Surface | Package | When to use |
|---|---|---|
| **GUI wizard** | `cli/claw-setup-gui/` | Operators who download the signed `.dmg` from the [releases page](https://github.com/RichardBNel/Factotem/releases/latest/download/nanoclaw-setup.dmg) and want a drag-into-Applications install. Auto-skips to the Factotem dashboard on subsequent launches when the orchestrator is healthy. |
| **CLI wizard** (`claw-setup`) | `cli/claw-setup/` | Headless / SSH / CI / recovery scenarios. Same twelve steps, `@clack/prompts` UI. The rest of this doc describes this surface. |

Both wizards share the **same state file** at
`~/.config/nanoclaw/setup-state.json` and call the **same setup
primitives** in `setup/*.ts`. You can start the GUI, get partway,
then resume from the CLI (or vice versa) — they both pick up at
`state.currentStep`. See [`ui-ux-direction.md`](ui-ux-direction.md)
for the three-surface architecture (CLI wizard, GUI wizard, dashboard)
and the hand-off rules between them.

The GUI surface has its own [README](../cli/claw-setup-gui/README.md)
and [agent rules](../cli/claw-setup-gui/CLAUDE.md). The remainder of
this document covers the CLI surface (`claw-setup`).

## Synopsis

From a fresh checkout, after `npm install` in the orchestrator package:

```bash
# From the npm-distributed bin (when installed)
npx claw-setup

# From inside the repo (after building the subpackage)
node cli/claw-setup/dist/index.js
```

## Prerequisites

- **Node.js ≥ 20** (the wizard probes `process.versions.node`; Node 22 is the realistic floor for development)
- **Docker** (running daemon — `docker info` must succeed)
- **Tailscale** (`tailscale status` must succeed)
- **macOS**: TCC implications — see below

### macOS TCC hard-stop

`launchd`-spawned services on macOS run inside a sandbox that silently denies writes under `~/Documents/`, `~/Desktop/`, and other privacy-protected locations. The wizard detects when its working directory matches `^/Users/[^/]+/Documents/` and refuses to proceed:

> Wizard cannot run from `~/Documents/`. macOS TCC silently kills writes. Move NanoClaw to `~/NanoClaw/` or similar.

If you run the wizard interactively from `~/Documents/` it will warn you and require explicit confirmation before continuing — though it is still strongly recommended to relocate.

## Profile selection

The first step prompts for a deployment profile (Q4 + R13 personas):

- **solo** — single operator on one machine. The standard layout: one main WhatsApp group, one launchd service, real Anthropic credential. *(Default.)*
- **hobbyist** — local-only experiment. No WhatsApp pairing, no real launchd service. The wizard runs the framework but skips live channel registration so you can probe the stack offline.
- **collaborator-invite** — short-circuits with a friendly message. The wizard sets up *new* deployments; if you are joining someone else's deployment, ask the operator for their dashboard URL and visit `/onboarding/accept-invite`.

Pass `--profile=<name>` to skip the prompt:

```bash
node cli/claw-setup/dist/index.js --profile=solo
```

## Persona (W.1, 2026-05-08)

Step `00-profile-mode` also prompts for the assistant's name (the "persona"):

```
◇  What name should your assistant respond to?
│  Sarah
   (default Andy; alphanumeric, 2-20 chars, must start with a letter)
```

The chosen name flows into three places:

1. **State** — `state.assistantName` (carried through the rest of the wizard, persisted in `~/.config/nanoclaw/setup-state.json`).
2. **Orchestrator `.env`** — the wizard appends `ASSISTANT_NAME=<name>` to the orchestrator's `.env` if not already set. `src/config.ts` reads it on every orchestrator startup; side effect: `DEFAULT_TRIGGER` becomes `@<name>` automatically.
3. **Main-group registration** — step 07 invokes `setup --step register --trigger '@<name>' --assistant-name '<name>'`, so the main group's `trigger_pattern` matches the persona.

The wizard never overwrites an existing `ASSISTANT_NAME` line in `.env` — operators with established `Andy` / `Ben` deployments keep their persona on re-runs. To change the persona of an existing deployment, edit `.env` manually and restart the orchestrator (`launchctl kickstart -k gui/$(id -u)/com.nanoclaw`).

## Resume semantics

State is persisted to `~/.config/nanoclaw/setup-state.json` (NOT under `~/Documents/`, for the TCC reasons above). The file is written atomically (write-to-tmp + rename) with mode `0600`.

Each step records `{ done }` in `completedSteps`. On any failure or interruption:

```bash
node cli/claw-setup/dist/index.js --resume
```

…picks up at the next non-`done` step. The wizard re-runs each step's `check()` first, so steps that have already been completed out of band (e.g. you ran `setup --step mounts` manually) are skipped.

## Re-entry: add another agent vs reconfigure

The GUI wizard detects existing agents in `setup-state.json` on launch.
When at least one agent exists, the Welcome screen swaps its "Re-run
setup anyway" CTA for two side-by-side buttons: **Add another agent**
and **Reconfigure**. The Add path sets `state.data.__mode =
'add-agent'`, jumps the operator straight to the Provider step, and —
on commit — *appends* a new non-default agent rather than overwriting
the default. The new agent gets:

- A unique display name (derived from the provider name; collision-safe
  rename if the provider's name is already taken — `Gemini` → `Gemini 2`).
- A slug-derived `id` used as the memory namespace (`agents/<id>`).
- The credentials registered against its own protocol's OneCLI secret.

After Credentials lands, the wizard routes the operator through a new
**PairingChoice** screen (v1.2.1, PR 12 § 2) — present only in
add-agent mode, hidden from first-run installs entirely. The operator
picks one of:

1. **Use the deployment's shared WhatsApp pairing** (recommended,
   pre-selected). The new agent's `channel_pairing_id` is set to the
   shared pairing's id and the wizard skips the WhatsApp QR step. In a
   group, operators address the new agent by `@<name>` exactly as they
   already do with the default agent.
2. **Pair a new WhatsApp number for this agent.** Wizard POSTs
   `/api/pairings` to register a fresh per-agent pairing, then jumps
   into the existing WhatsApp QR step parameterised by
   `NANOCLAW_AUTH_DIR=<root>/store/auth-<pairing-id>/` and
   `NANOCLAW_PAIRING_ID=<pairing-id>` env vars. The shared pairing's
   `creds.json` is untouched. The new agent gets its own phone number;
   senders DM it directly with no `@`-prefix.

Both branches PATCH `/api/agents/:id` with the resolved
`channel_pairing_id` and the orchestrator's `reloadConfig()` picks up
the new wiring without a restart. State hand-off flags
(`__pending_credential_agent_id`, `__pending_pairing_id`,
`__pending_pairing_auth_dir`) get cleared as each leg completes — see
PairingChoiceStep + WhatsAppStep for the lifecycle.

The CLI path does the same agent-append via `--resume` plus an
environment hint — a future PR exposes a `--add-agent` flag and the
pairing-choice prompt in the CLI wizard.

## Force re-pair

```bash
node cli/claw-setup/dist/index.js --force
```

`--force` does two things:

1. Bypasses the boot-time refusal when `store/auth/creds.json` exists.
2. Tells the WhatsApp pairing step (`06-pair-whatsapp`) to wipe and re-pair.

**You will lose the current WhatsApp session.** All pending unread state, ongoing message threads, and any device-specific keys go with it. Use only on intentionally clean deployments or when explicitly recovering from a broken pairing.

## Recovery

| Situation                                                  | Action                                                                                                  |
|------------------------------------------------------------|---------------------------------------------------------------------------------------------------------|
| A step failed mid-way                                      | State is preserved. From the factotem repo root, run `npm run claw-setup -- --resume`.                  |
| Total reset (start over from profile selection)            | `rm ~/.config/nanoclaw/setup-state.json` and rerun.                                                     |
| Existing WhatsApp pairing should be discarded              | `npm run claw-setup -- --force` (destructive — see above).                                              |
| Wizard misdetects the cwd                                  | Move the repo out of `~/Documents/` to e.g. `~/NanoClaw/`. The wizard refuses any path under `Documents`. |

## Logs

Level-3 raw command output (from any `runCommand` invocation, plus exit codes) is mirrored to:

```
~/.config/nanoclaw/setup-<timestamp>.log
```

…with mode `0600`. The same directory holds `setup-state.json`.

## Q8 acknowledgement

Wizard step **03 (`configure-onecli`)** invokes `onecli config add` with `--type generic`, the R3 friction 1 fix. The same `--type generic` shape is now data-driven for every cloud provider — each entry in `setup/providers.json` carries its own `host_pattern`, `header_name`, and `value_format`, so adding a 9th provider doesn't touch any step file. The wizard's verification step still expects a 401 from `/v1/messages` (auth-shape, not connection refused) when curling the OneCLI gateway directly with a fake credential.

## Step list

Per the Gemini blueprint (PR 3, Phase D), step `03-configure-onecli`
splits into three: `03` (ensure OneCLI gateway is up and authenticated
— provider-independent), `03a-provider` (data-driven provider picker
from `setup/providers.json`), and `03b-credentials` (data-driven
credential collection branching on `auth_kind`). Operators on a fresh
v1.0 install see the picker default to Anthropic; their existing
behaviour is preserved byte-for-byte. Operators picking Gemini get the
same step sequence with Gemini-specific copy + the Google AI Studio
sign-up link.

| ID                       | Title                                       | Notes                                                                |
|--------------------------|---------------------------------------------|----------------------------------------------------------------------|
| `00-profile-mode`        | Choose deployment profile                   | Short-circuits on `collaborator-invite`.                             |
| `01-check-prereqs`       | Probe Node, Docker, Tailscale, TCC          | TCC hard-stop runs here too.                                         |
| `02-install-prerequisites` | Install missing tools                     | Opens install URLs in browser; never auto-installs.                  |
| `03-configure-onecli`    | Ensure OneCLI gateway is running             | Provider-independent. Installs OneCLI inline via `sh -c` + 180s timeout (no second Terminal window); falls back to opening Terminal on timeout / non-zero exit. Authenticates the operator's local CLI to OneCLI. |
| `03a-provider`           | Pick the agent's AI provider                | Data-driven `clack.select` from `setup/providers.json`. Anthropic-first ordering. Writes `provider_default` and the default agent's `provider` field. |
| `03b-credentials`        | Collect provider credentials                | Branches on `auth_kind`: `api-key` collects the key + probes the provider's models endpoint + registers via `onecli secrets create` using the registry's `host_pattern`/`header_name`/`value_format`. `none` (local providers) probes the local URL and advances. `oauth` is stubbed for now. |
| `pairingChoice` (GUI)    | Shared vs. new WhatsApp pairing (add-agent only) | v1.2.1 add-agent branch (PR 12 § 2). Skipped on first-run installs. Routes to either Mounts (shared) or WhatsApp (new) after POSTing `/api/pairings` and PATCHing the new agent's `channel_pairing_id`. CLI mirror lands in a follow-up. |
| `04-mounts-allowlist`    | Configure mount allowlist                   | Wraps `setup --step mounts`.                                         |
| `05-build-container`     | Build agent container                       | Invokes `container/build.sh`; surfaces image SHA.                    |
| `06-pair-whatsapp`       | Pair WhatsApp                               | Refuses over existing creds without `--force`. Spawns `src/whatsapp-auth.ts` with stdio inheritance to render the QR. v1.2.1 parameterises per pairing via `NANOCLAW_AUTH_DIR` + `NANOCLAW_PAIRING_ID` env vars (defaults preserve byte-identical v1.0 behaviour). |
| `09-install-launchd`     | Install com.nanoclaw plist                  | Generates plist + (default-Yes) auto-bootstraps. Reordered before 07 in W.1 so 07/08 run against a live orchestrator. |
| `07-register-main-group` | Pick main WhatsApp group                    | Polls live orchestrator's chats DB; SIGHUPs after register. Reordered after 09 in W.1. |
| `08-configure-openmode`  | Enable open-DM mode (auto-onboard DMs)      | Default Yes. Patches main group's `container_config.openMode`; SIGHUPs. Repurposed in W.1 from optional budget gate. |
| `10-smoke-test`          | Curl `/health` + send test message          | Profile-dependent.                                                   |
| `11-handoff`             | Print operator cheat-sheet + install Doctor + recovery panel | Reads `~/.config/nanoclaw/machine.json`. Best-effort installs `recovery.html` and the Tauri Doctor (M1.6). |

Note: the table is in **execution order** (W.1 reordering puts 09 before 07/08). `STEPS` in `cli/claw-setup/src/index.ts` is the source of truth. Step IDs are unchanged — only the run order moves, so resuming from existing `~/.config/nanoclaw/setup-state.json` files is unaffected.

## Open-DM mode (W.1, 2026-05-08)

Step `08-configure-openmode` was repurposed from "optional OpenMode budget gate" (default Off) to **"open-DM enabler" (default Yes)**. With open-DM mode on, any direct-message sender to the agent's WhatsApp number is auto-onboarded into a per-sender `open_dm` container with isolated memory; without it, only registered groups receive replies and DMs are dropped silently — including DMs from the operator's own phone.

The step:

1. Reads `registered_groups WHERE is_main = 1` from `store/messages.db` to find the main group.
2. Default-Yes prompt to enable open-DM mode.
3. Default-`500` prompt for `dailyBudgetCents` (host-side cost cap).
4. Patches the main group's `container_config.openMode` JSON with `{ enabled: true, dailyBudgetCents, rateLimit: { tokensPerHour: 30, burstMax: 5 } }`. Existing keys (additionalMounts, agentProfile, model, etc.) are merged in, never replaced.
5. SIGHUPs the live orchestrator (`pgrep -f 'dist/index.js'` + `kill -HUP`) so the next inbound DM hits the new config — no `launchctl restart` needed.

If no main group is registered (e.g. step 07 deferred), the step is a no-op — operators re-run with `--resume` after registering a main group.

## Factotem Doctor (Phase 1)

The wizard's handoff step (M1.6) installs the signed + notarized **Factotem Doctor** menu-bar app to `/Applications/Factotem Doctor.app` and launches it so the tray icon appears immediately. The Doctor surfaces Docker / OneCLI / NanoClaw health every 5 seconds and exposes a typed-confirm `Repair Stack…` action for cold-start recovery.

The install is **best-effort** and never fails the wizard. Source order:

1. **Locally-built bundle** at `cli/claw-doctor/src-tauri/target/release/bundle/macos/Factotem Doctor.app` (produced by `cd cli/claw-doctor && cargo tauri build`).
2. **Public-mirror fallback** — if the local bundle is missing, `install-doctor.sh` downloads the latest `.dmg` from the public release mirror at [github.com/RichardBNel/Factotem/releases/latest/download/Factotem-Doctor.dmg](https://github.com/RichardBNel/Factotem/releases/latest/download/Factotem-Doctor.dmg) via plain `curl` (no `gh` CLI or auth required — the mirror repo is public), mounts it, and installs from there. Lets operators who only want the Doctor (not the orchestrator) install without a Rust toolchain.
3. **If both fail**, the wizard warns and skips — operator can install later by running `bash scripts/install-doctor.sh` (will retry the public-mirror download), or manually drag the `.dmg` from the mirror into `/Applications/`.

After install, the running Doctor (v0.1.2+) auto-detects future releases and prompts the operator. See [`docs/RELEASES.md`](RELEASES.md) for the full update flow.

### Standalone installer

`scripts/install-doctor.sh` works outside the wizard for re-installs, upgrades, and uninstalls. It mirrors `scripts/install-recovery.sh`:

| Mode | Effect |
|---|---|
| `bash scripts/install-doctor.sh` | Stop running Doctor → `ditto` source .app to `/Applications` → strip quarantine xattr → relaunch. Idempotent. |
| `bash scripts/install-doctor.sh --uninstall` | Stop running Doctor → remove `/Applications/Factotem Doctor.app` → unload + remove `~/Library/LaunchAgents/Factotem Doctor.plist` → remove `~/Library/Application Support/Factotem/doctor-settings.json`. |
| `bash scripts/install-doctor.sh --verify` | Read-only — prints whether source builds, the .app is installed, the process is running, the autostart agent is registered, and whether settings exist. |

The script refuses to overwrite `/Applications/Factotem Doctor.app` if its `CFBundleIdentifier` is something other than `co.factotem.doctor` — protects against an unrelated app with the same display name.

`/Applications` is user-writable on modern macOS for single-user installs (no `sudo` required). On a corporate-managed Mac with `/Applications` locked, `ditto` fails cleanly and the wizard logs a warning; copy manually with administrator privileges.
