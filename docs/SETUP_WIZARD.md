# Setup Wizard (`claw-setup`)

Operator-facing cold-start onboarding for new NanoClaw deployments. The wizard wraps the existing setup primitives with resumability, preflight checks, and an interactive UI built on `@clack/prompts`.

## Synopsis

From a fresh checkout, after `npm install` in the orchestrator package:

```bash
# From the npm-distributed bin (when installed)
npx claw-setup

# From inside the repo (after building the subpackage)
node cli/claw-setup/dist/index.js
```

## Prerequisites

- **Node.js ≥ 24** (the wizard probes `process.versions.node`)
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

## Resume semantics

State is persisted to `~/.config/nanoclaw/setup-state.json` (NOT under `~/Documents/`, for the TCC reasons above). The file is written atomically (write-to-tmp + rename) with mode `0600`.

Each step records `{ done }` in `completedSteps`. On any failure or interruption:

```bash
node cli/claw-setup/dist/index.js --resume
```

…picks up at the next non-`done` step. The wizard re-runs each step's `check()` first, so steps that have already been completed out of band (e.g. you ran `setup --step mounts` manually) are skipped.

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
| A step failed mid-way                                      | State is preserved. Run `claw-setup --resume`.                                                          |
| Total reset (start over from profile selection)            | `rm ~/.config/nanoclaw/setup-state.json` and rerun.                                                     |
| Existing WhatsApp pairing should be discarded              | `claw-setup --force` (destructive — see above).                                                         |
| Wizard misdetects the cwd                                  | Move the repo out of `~/Documents/` to e.g. `~/NanoClaw/`. The wizard refuses any path under `Documents`. |

## Logs

Level-3 raw command output (from any `runCommand` invocation, plus exit codes) is mirrored to:

```
~/.config/nanoclaw/setup-<timestamp>.log
```

…with mode `0600`. The same directory holds `setup-state.json`.

## Q8 acknowledgement

Wizard step **03 (`configure-onecli`)** invokes `onecli config add` with `--type generic`, the R3 friction 1 fix. The companion `setup` skill at `.claude/skills/setup/SKILL.md` was updated in the same change to instruct operators using the dashboard or CLI to register the Anthropic credential as `--type generic` (not `--type anthropic`). The wizard's verification step expects a 401 from `/v1/messages` (auth-shape, not connection refused) when curling the OneCLI gateway directly with a fake `x-api-key`.

## Step list

| ID                       | Title                                       | Notes                                                                |
|--------------------------|---------------------------------------------|----------------------------------------------------------------------|
| `00-profile-mode`        | Choose deployment profile                   | Short-circuits on `collaborator-invite`.                             |
| `01-check-prereqs`       | Probe Node, Docker, Tailscale, TCC          | TCC hard-stop runs here too.                                         |
| `02-install-prerequisites` | Install missing tools                     | Opens install URLs in browser; never auto-installs.                  |
| `03-configure-onecli`    | Register Anthropic credential               | Uses `--type generic` (Q8 fix).                                      |
| `04-mounts-allowlist`    | Configure mount allowlist                   | Wraps `setup --step mounts`.                                         |
| `05-build-container`     | Build agent container                       | Invokes `container/build.sh`; surfaces image SHA.                    |
| `06-pair-whatsapp`       | Pair WhatsApp                               | Refuses over existing creds without `--force`. Live-pairing TODO.    |
| `07-register-main-group` | Pick main WhatsApp group                    | Direct sqlite write to `registered_groups`.                          |
| `08-configure-openmode`  | Optional OpenMode budget                    | Off by default.                                                      |
| `09-install-launchd`     | Install com.nanoclaw plist                  | Generates plist; bootstrap is operator-driven.                       |
| `10-smoke-test`          | Curl `/health` + send test message          | Profile-dependent.                                                   |
| `11-handoff`             | Print operator cheat-sheet + install Doctor + recovery panel | Reads `~/.config/nanoclaw/machine.json`. Best-effort installs `recovery.html` and the Tauri Doctor (M1.6). |

## Factotem Doctor (Phase 1)

The wizard's handoff step (M1.6) installs the signed + notarized **Factotem Doctor** menu-bar app to `/Applications/Factotem Doctor.app` and launches it so the tray icon appears immediately. The Doctor surfaces Docker / OneCLI / NanoClaw health every 5 seconds and exposes a typed-confirm `Repair Stack…` action for cold-start recovery.

The install is **best-effort** and never fails the wizard. It depends on the Doctor having been built first:

```bash
cd cli/claw-doctor && cargo tauri build
```

If the bundle is missing at wizard time, step 11 warns and skips. The operator can install later by re-running:

```bash
bash scripts/install-doctor.sh
```

### Standalone installer

`scripts/install-doctor.sh` works outside the wizard for re-installs, upgrades, and uninstalls. It mirrors `scripts/install-recovery.sh`:

| Mode | Effect |
|---|---|
| `bash scripts/install-doctor.sh` | Stop running Doctor → `ditto` source .app to `/Applications` → strip quarantine xattr → relaunch. Idempotent. |
| `bash scripts/install-doctor.sh --uninstall` | Stop running Doctor → remove `/Applications/Factotem Doctor.app` → unload + remove `~/Library/LaunchAgents/Factotem Doctor.plist` → remove `~/Library/Application Support/Factotem/doctor-settings.json`. |
| `bash scripts/install-doctor.sh --verify` | Read-only — prints whether source builds, the .app is installed, the process is running, the autostart agent is registered, and whether settings exist. |

The script refuses to overwrite `/Applications/Factotem Doctor.app` if its `CFBundleIdentifier` is something other than `co.factotem.doctor` — protects against an unrelated app with the same display name.

`/Applications` is user-writable on modern macOS for single-user installs (no `sudo` required). On a corporate-managed Mac with `/Applications` locked, `ditto` fails cleanly and the wizard logs a warning; copy manually with administrator privileges.
