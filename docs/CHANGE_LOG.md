# Change Log

Timestamped record of significant changes to this BenClaw fork.

---

## 2026-05-08

### Phase 3 / Doctor v0.1.11 — fix GUI-vs-shell PATH false-fail in prereq probes

Hot-fix for v0.1.10's pre-flight checklist (R1). On any macOS host where `launchctl getenv PATH` is unset (the default unless the operator has explicitly run `sudo launchctl config user path …`), the Doctor — being a GUI app launched by Finder/Spotlight/launchd — inherited the launchd-default PATH (`/usr/bin:/bin:/usr/sbin:/sbin`), which **excludes** `/usr/local/bin` (where the official Node.js .pkg installs) and `/opt/homebrew/bin` (where Homebrew installs on Apple Silicon). The Welcome window's `tokio::process::Command::new("node")` call returned `No such file or directory`, the prereq checklist marked the operator's freshly-installed Node 24.15.0 as "not installed", and the "Open Terminal" CTA stayed gated. Identical class of bug also silently affected the docker, tailscale, and git probes — all four ran with the impoverished GUI PATH. Same canonical macOS issue that bites VS Code, Slack, and every other GUI app calling out to developer-tools binaries; standard fix is the [`fix-path`](https://www.npmjs.com/package/fix-path)/[`shell-env`](https://github.com/sindresorhus/shell-env) pattern.

**The fix.** New module `cli/claw-doctor/src-tauri/src/path_resolver.rs` (~190 lines incl. doc-comment + tests). One public function: `lift_path_at_startup()`. Spawns `/bin/zsh -ilc 'echo $PATH'` (interactive flag mandatory — `~/.zshrc` only sources for interactive shells, and that's where nvm / volta / asdf inject their PATH shims) on a worker thread bounded by `mpsc::recv_timeout(2s)` so a hung shell config can't block app boot. Falls back to `/bin/bash -ilc` for operators on older macOS or who switched away from zsh. Defends against `.zshrc` banner output (powerlevel10k status, motd) by extracting the LAST non-empty line of stdout (PATH itself is always single-line per POSIX). Sanity-checks the lifted string contains `:` or starts with `/` before trusting it. Merges `lifted + inherited + canonical_fallbacks` (the fallbacks are `/usr/local/bin`, `/opt/homebrew/bin`, sbin variants — appended unconditionally so operators with no shell config at all still see Node) and calls `std::env::set_var("PATH", merged)` exactly once. Wired into `lib.rs::run()` immediately after tracing init and BEFORE `tauri::Builder::default()` — `set_var` is unsound when called concurrently with other env-reading threads, so single-threaded startup is the only safe window. Two unit tests confirm fallback dirs always present + lifted-PATH ordering wins.

**Zero per-probe code change required.** Every existing `Command::new(...)` in `prereqs.rs` (git/node/docker/tailscale), `probe.rs` (orchestrator process detection), `pull.rs` (`git pull` + `npm` invocations), and `repair.rs` (`launchctl kickstart`) inherits the merged PATH automatically. The fix is therefore both narrow (one new module + one wiring line) and complete (covers every subprocess the Doctor will ever spawn).

**Operator-side workaround until v0.1.11 ships.** `sudo launchctl config user path "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"` then restart the Doctor (or whole session). Power-user fix; v0.1.11 makes it unnecessary for everyone.

**Files changed.**
- `cli/claw-doctor/src-tauri/src/path_resolver.rs` (new, ~190 lines)
- `cli/claw-doctor/src-tauri/src/lib.rs` (one `mod path_resolver;` + one call inside `run()`)
- 5-file version bump to 0.1.11 (`package.json`, `package-lock.json`, `tauri.conf.json`, `Cargo.toml`, `Cargo.lock`)

**Convention check.** Pure additive — no existing Tauri commands removed, no existing API contracts changed, no event channels touched. PrereqChecklist UI behaviour is unchanged on machines that already worked (lifted PATH is a strict superset of GUI-default PATH); previously-broken machines now resolve binaries the same way Terminal does. Reversal path: revert the v0.1.11 commits; isolated module is removable without touching any caller.

**Evidence the fix is needed (canonical incident).** Operator on `fctm-1@36-DE-B4-45-AE-3E`, fresh Doctor v0.1.10 install, 2026-05-08:

```text
$ echo "version: $(node --version 2>&1)"
$ echo "binary:  $(command -v node 2>&1)"
$ echo "shell PATH: $PATH"
$ echo "GUI PATH (what Doctor sees):"
$ launchctl getenv PATH
version: v24.15.0
binary:  /usr/local/bin/node
shell PATH: /usr/local/bin:...
GUI PATH (what Doctor sees):
                                 ← empty
```

Full ben-log entry: [`ben-log/2026-05-08-doctor-prereq-gui-path.md`](../ben-log/2026-05-08-doctor-prereq-gui-path.md).

**Recovery tag:** `pre-doctor-0.1.11-2026-05-08` (at v0.1.10 release tip, before any v0.1.11 commit landed).

### Phase 3 / Doctor v0.1.10 — pre-flight checklist + bootstrap one-liner

Ships R1 + R2 from the 2026-05-08 setup-journey UX audit (`assessments/2026-05-08-setup-journey-ux.md`, kept outside the repo as a workspace artefact). The Welcome window now actively probes git, node, docker, and tailscale before exposing the "Open Terminal" CTA — failures move from "operator stranded in Terminal with `command not found: npm`" to "Welcome window says 'Install Node.js, then click Recheck'". The cold-start one-liner the Doctor stages into Terminal collapses from a 110-character `git clone … && cd … && npm run …` chain to a single `curl -fsSL …/bootstrap.sh | sh` (the same idiom oh-my-zsh, nvm, rustup use). Both changes attack the highest-frequency derailments the audit flagged 🔴 for non-technical operators. Aligned with [`docs/VISION.md`](VISION.md) pillar 5 (every CLI step is product debt) and pillar 4 (wizard → fully housed app wrapper) — every Terminal hop the Doctor absorbs is a step toward the EasyClaw shape pillar 4 names as the long-run target.

**A. Pre-flight prereq checklist (R1).** New module `cli/claw-doctor/src-tauri/src/prereqs.rs` exposes two Tauri commands. `check_all_prereqs()` runs four parallel probes (`git --version`, `node --version`, `docker info`, `tailscale status`), each bounded by a 3s timeout, and returns `Vec<PrereqResult>` with per-row `installed` / `ok` / `detail` / `install_url` / `fix_action`. Node is checked against `major >= 20` to match the wizard's existing prereq probe at `cli/claw-setup/src/steps/01-check-prereqs.ts`. `launch_docker_and_wait()` is the Doctor-side mirror of v0.1.10's wizard-side R3 fix (Docker auto-launch): `open -a "Docker"` then poll `docker info` every 2s for up to 60s. Both commands are wired into `lib.rs::invoke_handler`. The Welcome window renders the four probes as a checklist on mount, gates the "Open Terminal" CTA on `git` and `node` (the only two the wizard can't auto-handle) being green, and shows a one-click "Launch Docker" button when Docker.app is on disk but the daemon is stopped. Recheck button re-runs all four after install. TypeScript wrappers added to `cli/claw-doctor/src/lib/tauri.ts` (`PrereqResult`, `FixAction`, `checkAllPrereqs`, `launchDockerAndWait`).

**B. Curl-bootstrap one-liner (R2).** New `scripts/bootstrap.sh` (executable, 9.4 KB) handles git/node preflight with actionable hints (Xcode CLT auto-prompt for git, nodejs.org link for node), enforces the TCC-safe target dir `$HOME/factotem` (refuses paths under `~/Documents/` per the same guard the wizard's `inDocumentsRoot()` uses at `cli/claw-setup/src/index.ts:81`), supports `FACTOTEM_DIR=…` override, and cleanly `exec`s into `npm run claw-setup`. The Doctor now stages `curl -fsSL https://github.com/RichardBNel/Factotem/releases/latest/download/bootstrap.sh | sh` into Terminal instead of the previous multi-tool chain. Mirrors the public-mirror curl pattern `scripts/install-doctor.sh` already uses for the .dmg fallback (line 168). Updated `cli/claw-doctor/src-tauri/src/commands.rs::open_setup_in_terminal` AppleScript and `cli/claw-doctor/src/views/WelcomeView.tsx::SETUP_COMMAND`.

**Files changed.**
- `cli/claw-doctor/src-tauri/src/prereqs.rs` (new, 220 lines)
- `cli/claw-doctor/src-tauri/src/lib.rs` (module declaration + invoke_handler)
- `cli/claw-doctor/src-tauri/src/commands.rs` (`open_setup_in_terminal` AppleScript)
- `cli/claw-doctor/src/lib/tauri.ts` (PrereqResult / FixAction types + 2 command wrappers)
- `cli/claw-doctor/src/views/WelcomeView.tsx` (PrereqChecklist + PrereqRow components, CTA gating, SETUP_COMMAND)
- `scripts/bootstrap.sh` (new)
- 5-file version bump to 0.1.10 (`package.json`, `package-lock.json`, `tauri.conf.json`, `Cargo.toml`, `Cargo.lock`)

**Convention check.** Pure additive — no existing Tauri commands removed, no existing event channels changed, no schema migrations. The `PrereqChecklist` component renders only in the NotInstalled state (when `isStackPresent` is false) so existing-deployment operators who reopen the Welcome window see no behaviour change. `open_setup_in_terminal` still uses `do script` (no auto-execute) — the operator still presses Enter in Terminal to run the bootstrap. Reversal path: revert the v0.1.10 commit; the prereqs module + bootstrap script are isolated and removable without touching any other surface.

**Pipeline note.** Until the next mirror release publishes `scripts/bootstrap.sh` to the public mirror at [RichardBNel/Factotem](https://github.com/RichardBNel/Factotem), the curl URL the new Doctor stages will return 404 and operators see the same UX as today (the script is committed in the source tree at `scripts/bootstrap.sh`). CI's release-asset manifest needs to learn to upload `bootstrap.sh` alongside the existing `Factotem-Doctor.dmg` etc. for this to land for operators.

**Recovery tag:** `pre-doctor-0.1.10-2026-05-08` (at `059697d`).

### Phase 3 / Setup-journey UX — three low-risk landings from the audit

Implements R1, R2, R3 + vestigials F11, F13 from the 2026-05-08 setup-journey UX audit (`assessments/2026-05-08-setup-journey-ux.md` — lives outside the repo as a workspace artefact). The audit walked the journey from "operator downloads `Factotem-Doctor.dmg` from [RichardBNel/Factotem](https://github.com/RichardBNel/Factotem)" through to "agent live on WhatsApp" and identified three derailing friction points (🔴) for non-technical operators: Node.js missing fails Terminal hard, OneCLI dashboard signup is the heaviest cognitive load, and the WhatsApp QR is hard to scan in Terminal. These commits address the cheapest derailment (Node missing) and two enabling improvements; OneCLI bootstrap (R5) and Doctor-rendered QR (R6) are deferred per the audit's medium-risk classification.

Aligned with [`docs/VISION.md`](VISION.md) pillar 5 (radical simplification — every CLI step exposed to operators is product debt) and pillar 4 (wizard → fully housed app wrapper — every Terminal hop the Doctor can absorb is a step toward EasyClaw shape).

**R1 — Pre-flight checklist inside the Welcome window.** New Doctor module `cli/claw-doctor/src-tauri/src/prereqs.rs` exposes two Tauri commands: `check_all_prereqs()` (parallel `git --version`, `node --version`, `docker info`, `tailscale status` probes, all bounded by 3s timeout, returns `Vec<PrereqResult>` with `installed` / `ok` / `detail` / `install_url` / `fix_action`) and `launch_docker_and_wait()` (the Doctor-side mirror of R3's wizard fix — `open -a "Docker"` + 60s poll loop). `WelcomeView.tsx` renders the four probes as a checklist on mount, gates the "Open Terminal" CTA on `git` and `node` (the only two the wizard can't auto-handle) being green, and shows a Recheck button for re-probing after fixing. The Docker row gets a "Launch Docker" button when Docker.app is on disk but the daemon is stopped. Failures stay inside the Doctor with actionable per-row install links instead of landing 30s later in Terminal as `command not found: npm`. Lib.rs wires both commands into `invoke_handler`. TypeScript wrappers added to `lib/tauri.ts` (`PrereqResult`, `FixAction`, `checkAllPrereqs`, `launchDockerAndWait`).

**R2 — Bootstrap script in the public mirror, replaces the multi-line cold-start one-liner.** New `scripts/bootstrap.sh` to be published as a release asset on [RichardBNel/Factotem](https://github.com/RichardBNel/Factotem) alongside `Factotem-Doctor.dmg`. Doctor's `WelcomeView.tsx::SETUP_COMMAND` and `commands.rs::open_setup_in_terminal` both updated from `git clone https://github.com/donkruger/factotem.git && cd factotem && npm run claw-setup` (110 chars, multi-tool) to `curl -fsSL https://github.com/RichardBNel/Factotem/releases/latest/download/bootstrap.sh | sh` (98 chars, single shape — same idiom as oh-my-zsh, nvm, rustup, homebrew). The bootstrap script handles git/node preflight with actionable hints (Xcode CLT auto-prompt for git, nodejs.org link for node), enforces TCC-safe target dir (`$HOME/factotem`, **not** under `~/Documents/`), supports `FACTOTEM_DIR=...` override, and cleanly `exec`s into `npm run claw-setup`. Mirrors the public-mirror curl pattern `install-doctor.sh` already uses for the .dmg — no `gh` CLI, no GitHub auth. **Pipeline note:** until the next release publishes `bootstrap.sh` to the mirror, the curl call will 404 and operators on existing Doctor installs see the same UX as today (the script is committed in the source tree at `scripts/bootstrap.sh` and CI needs to add it to the release-asset manifest).

**R3 — Auto-launch Docker Desktop if installed but stopped.** `cli/claw-setup/src/steps/01-check-prereqs.ts` now wraps Docker probing in `probeDockerWithAutoLaunch(ui)`: first probe is the existing `docker info`, but on macOS-only failure paths the wizard checks for `/Applications/Docker.app` and, if present, runs `open -a "Docker"` + polls `docker info` every 2s for up to 60s before classifying as missing. Eliminates the high-frequency false-fail Don's machines hit every reboot until launchd's Docker autostart kicks in. The Doctor's R1 `launch_docker_and_wait` Tauri command mirrors this same logic on the Welcome window side. Heartbeat copy explains "this typically takes 15–45s on first boot" so the operator doesn't think the wizard is hung.

**F11 — Handoff cheat-sheet: Doctor-first, demote `tail`/`launchctl` to "if you ever need to debug from Terminal".** `cli/claw-setup/src/steps/11-handoff.ts` reorders the cheat-sheet so the Factotem Doctor section ("your daily surface") leads, dashboard URL second, recovery panel third (gated on `recoveryInstalled`), and the raw `curl health`, `launchctl list`, `tail -f` commands moved to a small "If you ever need to debug from Terminal" section at the bottom — present but not load-bearing. The previous "Common commands" block was a manual-page tone that pillar 5 explicitly flags as a smell ([`docs/VISION.md`](VISION.md) line 81).

**F13 — Stale `gh`-CLI fallback hint in `docs/SETUP_WIZARD.md`.** Doc lagged behind R.6's switch in `scripts/install-doctor.sh` (line 168) to plain `curl` against the public mirror. The line now correctly describes the public-mirror fallback, links to the stable `Factotem-Doctor.dmg` URL, and notes no `gh` or auth is needed. Single-line copy fix.

**Builds.** `npm run build` clean in both `cli/claw-setup` (TypeScript) and `cli/claw-doctor` (Vite). `cargo check` clean in `cli/claw-doctor/src-tauri`. No new dependencies; the new Doctor commands use existing tokio + serde + the `tokio::process::Command` shape already used by `probe.rs`.

**Deferred.** R4 (Setup-progress mirror window in the Doctor — ~2 days, low risk), R5 (OneCLI key bootstrap path — needs upstream investigation), R6 (Doctor-rendered WhatsApp QR — ~3 days, medium risk). Audit doc has full sequencing rationale.

### Phase 3 / Wizard UX — EasyClaw-inspired inline OneCLI install (`ae453ae`)

Removes one of the two external-Terminal pop-ups in the cold-start wizard. Step 03 used to spawn a second Terminal window via `osascript "tell application Terminal to do script ..."` for the OneCLI installer (`curl … | sh && curl … | sh`). Non-technical operators saw two Terminals open at once and didn't know which was the wizard.

Pattern borrowed from [EasyClaw](https://github.com/ybgwon96/easyclaw) — an Electron + React installer for OpenClaw that consciously avoids ever opening a Terminal. Their [`runWithLog(cmd, args, onLog)`](https://github.com/ybgwon96/easyclaw/blob/main/src/main/services/installer.ts) helper spawns the install command in the main process, decodes stdout/stderr line-by-line, and streams each line into the renderer via IPC. We can't go full GUI today (the wizard itself is a CLI app), but we can run the install inline within the wizard's existing terminal window, which is half the win.

Now: `ui.runCommand('sh', ['-c', installCmd])` runs the install inline with a 30s heartbeat tick (same shape as `05-build-container.ts`'s pattern). Bounded by `Promise.race` against a 180s wall-clock timeout — if the installer hangs on a sudo prompt, an EULA wait, or a network stall, the wizard falls back to the legacy Terminal-pop path with a clear `ui.warn` explaining why. Operator strictly no worse off than today; happy path is one Terminal window instead of two.

The remaining external-Terminal pop — Doctor's "Set up NanoClaw…" tray button opening Terminal for `git clone && npm run claw-setup` — needs a Tauri-based GUI wizard to eliminate (deferred to a v1.5 milestone; tracked under [`docs/VISION.md`](VISION.md) pillar 4).

**Files.** `cli/claw-setup/src/steps/03-configure-onecli.ts` (replace osascript block with inline runCommand + heartbeat + 180s timeout + fallback). `docs/SETUP_WIZARD.md` (one-line note on the step-03 row).

### Phase 3 / Wizard UX — Tier 1+2 polish pass (`988734f`)

Fourteen low-risk UX edits across the cold-start wizard, scoped to copy/feedback improvements and small additive logic. No step-order changes, no state-schema changes, no new steps. Aligned with [`docs/VISION.md`](VISION.md) pillar 2 (human-readable UX) and pillar 5 (every CLI step is product debt; every raw-stderr error is a UX failure).

**Tier 1 — copy-only.**

- `docs/SETUP_WIZARD.md`: stale "Node ≥ 24" → "≥ 20" to match the actual prereq probe at `01-check-prereqs.ts:42`.
- `00-profile-mode.ts`: profile labels flipped — friendly text ("Just me on my own machine") now primary; technical token in hint. `collaborator-invite` exit message warmed up.
- `02-install-prerequisites.ts`: declined-install warning now embeds the full `npm run claw-setup -- --resume` command in a `ui.note`, not bare `--resume` jargon.
- `03-configure-onecli.ts`: `stderr.slice(0, 400)` → `slice(-400)` on both auth-login and secrets-create failures. Real onecli errors print at the end of stderr; head-truncation was hiding them.
- `06-pair-whatsapp.ts`: pairing time estimate "5–15 seconds" → "10–30 seconds (longer on slow networks or first-time iCloud sync)".
- `09-install-launchd.ts`: confirm prompt drops the redundant "(Default Yes." prefix — clack already shows the default.
- `11-handoff.ts`: outro "happy clawing" → "your assistant is ready". Removed unconditional KP integration line from cheat sheet (fresh operators don't have KP set up; the line was jargon).

**Tier 2 — additive logic.**

- `04-mounts-allowlist.ts`: mount allowlist note now explains what mounts are ("folders the agent can read or write, e.g. a Brain folder"), not just the default's shape.
- `05-build-container.ts`: new `getLastBuildActivity()` helper reads the most recent `[STDOUT]/[STDERR]` line from the wizard's session log and appends it to each 30s heartbeat tick. Operator now sees `still building… (90s elapsed) — last: Pulling base layer` rather than just ticks. Concrete signal of progress without leaving the terminal.
- `07-register-main-group.ts`: group-poll feedback now ticks every cycle with elapsed + remaining (`waiting for groups… 12s elapsed, 78s remaining`), not just on count change.
- `11-handoff.ts`: `machine.json` backstop — if the file is missing or has no `machineId` when handoff runs, seed a UUID + hostname + region (`"Local"`) so the cheat sheet shows real values instead of `<not yet generated>`. Best-effort; never fails the wizard. Removes the embarrassing placeholder Don's iMac was showing.
- `11-handoff.ts`: Doctor install failure tail capped to 5 lines (was 15), trimming the wall-of-stderr while keeping manual install options intact.
- `11-handoff.ts`: Factotem Doctor cheat-sheet line now mentions "Pull updates" alongside Repair Stack.

Builds clean; all 352 orchestrator tests still pass.

### Phase 3 / Doctor v0.1.9 — Per-step badge propagation fix

Surfaced live on Don's iMac while testing v0.1.8's "Pull upstream updates…" against a deliberately dirty working tree. Preflight correctly refused to mutate (the chain stopped at "Working tree is clean"), but the UI showed two visible defects:

1. The "Working tree is clean" badge stayed at **Pending** instead of flipping to **Failed (Xms)**.
2. The failure-footer detail rendered as `(no detail)` even though the Rust side had captured the dirty file list (`Uncommitted changes detected:\n M groups/main/CLAUDE.md\n …`) into the step's `detail` field.

Net effect: the operator could see *something* failed but had to drop to Terminal to learn *what*. That's exactly the kind of UX gap [`docs/VISION.md`](VISION.md) pillar 5 calls out — every error message hidden behind a generic "(no detail)" is a UX failure.

**Root cause.** Two independent state-propagation paths in `PullView.tsx` and `RepairView.tsx`:

- The `overall` state is set from BOTH the Tauri event channel AND the synchronous `result.overall` returned by `startPull()` / `startRepair()`. Whichever arrives later wins; the synchronous return always corrects whatever the events delivered.
- The per-step `progress` state was set ONLY from the event channel. The synchronous `result.steps[i].state` (which contains the authoritative final state of every step, including the failure detail) was ignored.

When events propagated cleanly the two paths agreed. When they didn't — likely a timing race between a fast preflight failure (~50ms) and the Tauri listener subscription, but the exact cause is irrelevant to the fix — the per-step badges stayed stuck at "Pending" while the failure footer correctly showed "failed".

**Fix.** Both views now reconcile `result.steps` into `progress` after the await resolves. The synchronous result is the authoritative final state by design (the `repair.rs` module doc says it explicitly: "the synchronous return value is the authoritative final result; events are advisory"). Same shape of fix as the WhatsApp `connect()` resolve fix (`bb632ed`) — when events are unreliable, fall back to the synchronous Promise return value.

After the fix, the "Working tree is clean" badge flips to **Failed (Xms)** with the dirty file list visible in its detail card. The operator sees exactly what's blocking Pull and has a clear next action (stash, commit, or revert).

**Files.** `cli/claw-doctor/src/views/PullView.tsx` + `RepairView.tsx` (the reconcile block — ~7 lines added in each, with a comment pointing at the `repair.rs` doc that establishes the result-as-authoritative invariant). Doctor version bump 0.1.8 → 0.1.9 across the standard 5 files.

**Recovery tag.** `pre-doctor-0.1.9-2026-05-08` (at `988734f`).

### Phase 3 / Doctor v0.1.8 — Pull upstream updates from the Doctor

Closes the productisation gap surfaced while shipping v0.1.7: the Doctor auto-updates its own binary, but the orchestrator + dashboard + claw-setup wizard explicitly *don't* auto-update — per the [README](../README.md), they "ship via the fork-and-modify workflow (`git pull` + `npm run build`) — they're not auto-updated because operators customise them." That's correct for customised forks like Ben's dev box (months of local commits, applied skills, edited `.env`), but it leaves un-customised deployments like Lexical Lighthouse manually running `git pull && npm install && npm run build` after every release.

v0.1.8 adds a one-click **Pull upstream updates…** action to the tray menu. The frontend, backend, and step-runner mirror the existing Repair Stack pattern; the new piece is a four-step preflight gate that refuses to mutate a customised fork.

**A. Tray-menu action + window (`cli/claw-doctor/src-tauri/src/{tray,commands}.rs`).** New `PULL_UPDATES` menu id slotted between "Repair Stack…" and "Show diagnostic details". Disabled in `NotInstalled` state with a "(NanoClaw not installed)" suffix, mirroring the existing dashboard/logs disabled treatment. Click opens window labelled `pull` with `?view=pull`.

**B. `pull.rs` — orchestrator-aware preflight + step builder (new module).**

- `resolve_orchestrator_root()` resolves the source tree by reading `WorkingDirectory` from `~/Library/LaunchAgents/com.nanoclaw.plist` via `plutil -extract`, then falling back to `~/factotem` (the documented installer path) and `~/Documents/NanoClaw/nanoclaw` (Don's dev path). Each candidate is gated on being a git repo (`.git/` present) so we never `git pull` something that just shares a path.
- `build_pull_manifest(&root)` returns a `RecoveryManifest` with eleven steps. Four are preflight: working tree clean, on `main`, fetched cleanly, and zero local-only commits ahead of `origin/main`. Each preflight failure prints a human-readable reason to stderr (e.g. "3 local-only commit(s) ahead of origin/main — pull would clobber them") so the run-failed detail card explains exactly what to do, not just "exit 1". The remaining seven do the actual work: pull, install + build orchestrator, install + build dashboard, `launchctl kickstart -k`, then a `curl /health` verify-with-polling block (same as the existing recovery manifest's verify step).
- Customised forks stay untouched: every preflight aborts the chain before any mutation. Any uncommitted edits or local commits cause the chain to stop with the error visible in the step row, with a footer reminding the operator that nothing was modified.

**C. Generic step-chain runner (`repair.rs`).** Refactored `run_repair` to delegate to a new `run_steps_chain(app, manifest, event_channel)`. Repair Stack continues to use the `repair-progress` channel; Pull uses `pull-progress`. Behaviour preserved exactly — the existing `run_repair(app, manifest)` signature is unchanged from RepairView's perspective. Three pure-function unit tests added for the bash-escaping helper that interpolates the orchestrator root path into each step's command (covers no-special, embedded-quote, and spaces-in-path cases) plus one shape test for the manifest builder.

**D. Tauri command wiring + frontend (`cli/claw-doctor/src/{lib/tauri.ts,views/PullView.tsx,main.tsx}`).** New `get_pull_manifest` + `start_pull` Tauri commands registered in the `invoke_handler!` array. Confirm phrase is `"PULL UPDATES"` (vs `"RESTART STACK"` for Repair) — server-side defence-in-depth gates `start_pull` on the typed-confirm match before any preflight runs. New `PullView.tsx` component mirrors RepairView (manifest load, typed-confirm gate, per-step state subscription, success/failure footers) but with copy that explains the preflight model and a less-alarming run button (accent colour rather than error red, since Pull isn't destructive — preflight protects you). The success footer notes that the tray icon should flip green within ~5s; the failure footer special-cases preflight failures to explain that nothing was modified.

**E. Doctor → 0.1.8.** Five files: `cli/claw-doctor/{package,package-lock}.json`, `cli/claw-doctor/src-tauri/{Cargo.toml,Cargo.lock,tauri.conf.json}`. Lockfiles regenerated via `npm install --package-lock-only` and `cargo check --offline`. Existing v0.1.7 binary's behaviour preserved — Pull is purely additive.

**Verification target.** Lexical Lighthouse — Don's iMac. After v0.1.8 lands via auto-update, the operator clicks the Doctor's tray icon, picks "Pull upstream updates…", types `PULL UPDATES`, clicks Run Pull. The chain runs preflight (all four green), pulls, builds, restarts. Tray icon flips green. Subsequent v0.1.9 / v0.1.10 / etc. orchestrator improvements ship via the same path — no more manual `git pull && npm run build` for un-customised deployments. Customised forks (Ben's dev box) see preflight refuse to run; the operator continues using `/update-nanoclaw` for selective cherry-pick.

**Recovery tag.** `pre-doctor-0.1.8-2026-05-08` (at `9db7f17`).

### Phase 3 / Doctor v0.1.7 — persona page + health probe wiring + reconnect-resolve fix

Tag-and-publish that bundles the orchestrator wins accumulated since v0.1.6 plus three small follow-ups surfaced while verifying Sarah on the iMac. The Doctor binary itself has zero code changes — the version bump is the ratchet that signals "the deployment behind me has these orchestrator improvements" and keeps the auto-updater pipeline exercised.

**A. WhatsApp `connect()` resolve fix (`src/channels/whatsapp.ts`).** High-severity hang surfaced on Don's iMac post-W.1 bootstrap. The orchestrator's main loop hung at `await channel.connect()` (`src/index.ts:993`) after a Baileys close-reopen cycle, so `queue.setProcessMessagesFn` (line 1052) and `startHttpServer` (line 1058) never ran — `launchctl print` reported `state = running` but `/health` returned 000 and the agent never replied. Cause: `scheduleReconnect()` invoked `connectInternal()` without forwarding the `onFirstOpen` callback, so the resolve passed to the original Promise was held only in the first connection scope and lost when that attempt closed. Fix: thread `onFirstOpen` through `scheduleReconnect(attempt, onFirstOpen?)`, retry path forwards it on each subsequent attempt. After: connect resolves on the first successful 'open' event whether that's attempt 1 or attempt N. Fully written up at `ben-log/2026-05-08-whatsapp-onfirstopen-lost-on-reconnect.md`. Productisation note: every channel implementation needs the same retry-forwards-resolve invariant — Telegram/Slack/Signal/Discord likely have analogous bugs.

**B. `/health` `probeOpenDm` now actually probes (`src/http/health.ts:217-228`).** v1 stub returned a hard-coded `{ enabled: false, daily_budget_cents: null, today_spent_cents: 0 }` regardless of state. Replaced with a SQLite read of the main group's `container_config.openMode` JSON via the existing `getProbeDb()` readonly connection — same pattern as `probeWhatsApp`. Returns the real `enabled`, `daily_budget_cents`, and `today_spent_cents` (joined with `open_spend_log` for today's UTC date). Fail-soft: every error path degrades to the original placeholder shape.

**C. `nanoclaw.version` now actually surfaces (`src/http/health.ts:79`).** Was `process.env.NANOCLAW_VERSION ?? 'unknown'` — env var is never set, so `/health` always reported `"version": "unknown"`. Now reads `package.json` once at module load via `JSON.parse(fs.readFileSync(...))` (the existing experimental-JSON-modules warning suggested avoiding `import assert`). Env var still wins if set, for CI override.

**D. Read-only Persona page (`/api/persona` + dashboard route `/persona`).**

- **`src/http/api.ts`** — new `GET /api/persona` returns `{ assistant_name, default_trigger, groups: [{ jid, name, folder, trigger, is_main }] }`. Reads `ASSISTANT_NAME` and `DEFAULT_TRIGGER` from `src/config.ts`, group list from `deps.getRegisteredGroups()`. No mutating endpoint in this release — operators continue to edit `.env` and re-register via the existing `setup --step register` path.
- **`dashboard/src/app/persona/{page.tsx,PersonaView.tsx}`** — new route modelled on `/groups`. Polls `/api/persona` every 10s. Renders three Cards: (1) global assistant name + default trigger Badge; (2) per-group table showing trigger and main/subgroup role; (3) "How to change persona" with the operator's `.env` line and a re-register command, both copy-to-clipboard.
- **`dashboard/src/components/layout/NavLinks.tsx`** — adds `Persona` link between Groups and Cost.
- **`dashboard/src/lib/nanoclaw.ts`** — adds `getPersona()` + `Persona`/`PersonaGroup` types mirroring the backend response.

**E. Doctor version bump → 0.1.7.** Five files: `cli/claw-doctor/package.json`, `cli/claw-doctor/package-lock.json`, `cli/claw-doctor/src-tauri/Cargo.toml`, `cli/claw-doctor/src-tauri/Cargo.lock`, `cli/claw-doctor/src-tauri/tauri.conf.json`. Lockfiles regenerated via `npm install --package-lock-only` and `cargo check --offline`. No Doctor code changes — the existing v0.1.6 binary behaviour is preserved.

**Verification target.** Lexical Lighthouse — Don's iMac. Pull, `npm install && npm run build`, `npm --prefix dashboard run build`, bootout/bootstrap. Expected `/health` shows real version + real openMode state; `/api/persona` returns Sarah + Mason Web Dev; `/persona/` renders in the browser. Doctor auto-update notification arrives within 4h of `latest.json` publication.

**Recovery tag.** `pre-doctor-0.1.7-2026-05-08` (at `bb632ed`).

### Phase 3 / W.1 — WhatsApp end-to-end + persona + open-DM + /health diagnose

After 14 separate papercuts landed across R.7→R.9 and the wizard finally completed end-to-end on Don's external iMac, three substantive issues remained that fell below the "true cold-start" bar:

1. **Persona was hardcoded as `Andy`.** The orchestrator's `ASSISTANT_NAME` defaults to `'Andy'` in `src/config.ts`; the wizard never prompted for a deployment-specific name. Don's iMac is meant to be `Sarah`.
2. **WhatsApp main-group registration still required manual command-line work.** The old step 07 spun up its own Baileys socket via `setup --step groups` BEFORE the orchestrator was bootstrapped — a brittle two-process race. On Don's iMac all 3 retries failed; he had to manually run `npx tsx setup/index.ts --step register --jid … --trigger '@Andy' --is-main` and `kill -HUP` the orchestrator afterwards.
3. **DMs were dropped silently.** The orchestrator was receiving DMs from Don's phone but `loadOpenMode(registeredGroups)` returned `undefined` because no main group had `openMode.enabled = true`, so the auto-onboard path never fired.

Plus a related bug: **the orchestrator's HTTP server (port 7842) wasn't binding** on the iMac. PID was alive and processing WhatsApp, but `lsof -iTCP:7842` returned empty — Doctor + dashboard unreachable.

**W.1 fixes all four together.**

**A. Persona configurability (step 00).** `cli/claw-setup/src/steps/00-profile-mode.ts` now prompts `What name should your assistant respond to?` (default `Andy`, validation `/^[A-Za-z][A-Za-z0-9]{1,19}$/`). The chosen name is persisted to (1) `state.assistantName` in `~/.config/nanoclaw/setup-state.json`, (2) `ASSISTANT_NAME=<name>` appended to the orchestrator's `.env` (only if not already set — operators with established `Andy` / `Ben` deployments aren't overwritten), and (3) the `--trigger '@<name>'` + `--assistant-name '<name>'` flags when registering the main group in step 07. Side effect: the orchestrator's `DEFAULT_TRIGGER` becomes `@<name>` automatically since `src/config.ts` derives it from `ASSISTANT_NAME`.

**B. WhatsApp end-to-end without manual commands.** The wizard pipeline reorders `06 → 07 → 08 → 09 → 10 → 11` to `06 → 09 → 07 → 08 → 10 → 11`. Step 09 (launchd bootstrap) now runs BEFORE step 07 so the orchestrator is the live source of truth for the chats table — no separate Baileys socket fighting for the auth state. The new step 07:

1. Polls `http://localhost:7842/health` (or `pgrep -f 'dist/index.js'` as fallback) for up to 30s waiting for the orchestrator.
2. Reads `chats` table for `@g.us` rows where `name IS NOT NULL`.
3. If empty: prompts the operator to send a message in the group, polls every 5s for up to 90s, prints a live count.
4. `clack.select` to pick one.
5. Runs `setup --step register --trigger '@<assistantName>' --assistant-name '<assistantName>' --is-main`.
6. **Sends `SIGHUP` to the orchestrator's PID** (`process.kill(pid, 'SIGHUP')`) so the existing handler at `src/index.ts:1084` reloads `registered_groups` from DB without a `launchctl restart`.

The brittle temp-script Baileys path is gone — the wizard reads the orchestrator's state, never opens its own WhatsApp socket.

**C. Open-DM mode (step 08).** `08-configure-openmode` repurposed from "optional OpenMode budget gate, default Off" to "open-DM enabler, default Yes":

1. Reads `registered_groups WHERE is_main = 1` from the LIVE DB (no longer trusts `state.data['main_jid']` which can drift across resumes).
2. Default-Yes prompt; default-`500` cents budget.
3. Patches the main group's `container_config.openMode` to `{ enabled: true, dailyBudgetCents, rateLimit: { tokensPerHour: 30, burstMax: 5 } }`. Existing keys merged in.
4. SIGHUPs the orchestrator. The next inbound DM hits the new config, gets evaluated by `evaluateOpenMode` in `src/open-mode.ts`, and auto-onboards into a per-sender `open_dm` container.

Old step 08 had a latent bug: it was writing to a non-existent column `containerConfig` (camelCase) — the actual SQLite column is `container_config` (snake_case). Fixed.

**D. /health diagnostic logging + binding fallback (`src/http/server.ts`).** Added per-checkpoint `logger.info` calls (`startHttpServer: entered` → `… /health route mounted` → `… /api/* routes mounted` → `… dashboard static export mounted` or `… dashboard/out absent — API-only mode` → `… app.listen() called, waiting for listening event` → `… HTTP server listening`). Wrapped the entire body in a try/catch so a synchronous failure in `mountApi` or route registration is logged at error level rather than swallowed. The dashboard mount was already conditional, but the diagnostic logging now makes "orchestrator alive but /health unreachable" debuggable from `tail -f logs/nanoclaw.log` alone.

**Files changed.**

- `cli/claw-setup/src/state.ts` — `StateSchema` gains `assistantName` (zod `.regex().default('Andy')` so existing state files load with `'Andy'` as fallback). `newState()` seeds `'Andy'`.
- `cli/claw-setup/src/steps/00-profile-mode.ts` — persona prompt + `ensureAssistantNameInEnv()` helper that appends `ASSISTANT_NAME=<name>\n` to `.env` (or creates it) if no existing line matches `^[\t ]*(?:export[\t ]+)?ASSISTANT_NAME[\t ]*=`.
- `cli/claw-setup/src/index.ts` — `STEPS` array reordered: `step09` moved before `step07`/`step08`. Step IDs unchanged; `completedSteps` is an unordered set so resume-from-old-state still works.
- `cli/claw-setup/src/steps/07-register-main-group.ts` — full rewrite: `waitForOrchestrator()` polls /health (with `pgrep` fallback), `readGroupChats()` reads the live DB, polls for new groups when empty, registers via `setup --step register`, SIGHUPs via `findOrchestratorPid()`. No more `setup --step groups` invocation.
- `cli/claw-setup/src/steps/08-configure-openmode.ts` — full rewrite: `findMainGroup()` reads `is_main = 1`, default-Yes prompt, patches `container_config` (snake_case — fixes latent bug), SIGHUPs.
- `src/http/server.ts` — diagnostic `logger.info` at every checkpoint; outer try/catch around `startHttpServer` body; "API-only mode" message when `dashboard/out` missing; logs `server.address()` on listening to confirm bind.
- `docs/SETUP_WIZARD.md` — new "Persona (W.1)" + "Open-DM mode (W.1)" sections; step table reordered to match execution order; row notes updated.
- `docs/CHANGE_LOG.md` — this entry.

**What W.1 deliberately doesn't do.**

- **No multi-channel persona.** The assistant name is global per deployment in v1; per-channel (Telegram, Slack, Discord) personas land in v1.5 once the federation arrives.
- **No per-group personas.** Same.
- **No migration tool for existing `Andy` / `Ben` deployments.** The `.env` write is "skip if `ASSISTANT_NAME` is already present" — operators upgrading the wizard get the new prompt on next clean run, but their existing deployment's persona is preserved. Manual switch: edit `.env`, restart orchestrator.
- **No dashboard UI for daily-budget / rate-limit edits.** Defaults are sufficient for v1; full UI is dashboard work, not wizard.

**Convention check.** Pure additive on the wizard side — one new state field with serde-default, one new prompt, two reordered steps, one repurposed step. Orchestrator-side change is logging + an outer try/catch in `startHttpServer` (no behaviour change when the listen succeeds, only better diagnostics when it doesn't). Reversal: `git revert <w1 commit>`.

**Recovery tag:** `pre-w1-2026-05-08`.

### Phase 2 / Release pipeline — R.9 (welcome CTA: drop `gh` requirement, surface real prereqs) → v0.1.6

Don ran R.8's welcome one-liner on his external iMac (a clean machine) and hit `zsh: command not found: gh`. The CTA assumed `gh` CLI was installed; on a fresh Mac it isn't. **Repo also flipped public** in the meantime, which means we don't need `gh` for auth anymore — plain `git clone` over HTTPS works.

R.9 makes two changes:

**1. Use `git clone` over HTTPS instead of `gh repo clone`.** `git` is much more universally available on macOS than `gh` — the Xcode Command Line Tools (which ship `git`) auto-prompt for install on first invocation, while `gh` requires an explicit Homebrew install. Now that the source repo is public, no GitHub auth is needed for the clone.

New welcome one-liner:

```
git clone https://github.com/donkruger/factotem.git && cd factotem && npm run claw-setup
```

**2. Surface the real prerequisites honestly.** The previous welcome copy said "source-repo access required" — which was accurate when the repo was private but no longer applies. The genuine prereqs on a fresh Mac are now:
- `git` (via Xcode CLT — macOS auto-prompts)
- Node.js 20+ (operator installs from nodejs.org — no automatic prompt)

The welcome card lists both with inline guidance: macOS will handle git automatically when the operator presses Enter, but Node has to be installed manually first. There's a link to nodejs.org and a `node --version` check command. Everything else (Docker, OneCLI, Tailscale, agent container, launchd plist) is handled by the wizard once it starts.

**Files changed.**

- `cli/claw-doctor/src/views/WelcomeView.tsx`:
  - `SETUP_COMMAND` constant updated to use `git clone https://github.com/donkruger/factotem.git`
  - Setup-state card rewritten — drop "private repo" / "source-repo access" framing; new "Prerequisites" section listing git + Node 20+ with the nodejs.org link and the `node --version` check tip
  - Removed the "Don't have access yet?" footer (no longer applicable since the repo is public)
  - Added `.hint.prereqs` styling for the new prereqs section
- `cli/claw-doctor/src-tauri/src/commands.rs` — `open_setup_in_terminal` AppleScript updated to stage `git clone https://github.com/donkruger/factotem.git && cd factotem && npm run claw-setup`. Docstring updated to reflect the real prereqs.
- Version bumped 0.1.5 → 0.1.6 in five locations (`package.json`, `package-lock.json`, `Cargo.toml`, `Cargo.lock`, `tauri.conf.json`).
- `docs/CHANGE_LOG.md` — this entry.

**Note on repo visibility.** The source repo (`donkruger/factotem`) flipped public during the R.8 → R.9 cycle. The two-repo split (source + release-mirror) still applies operationally — release artefacts continue to land on `RichardBNel/Factotem` because that's where CI's `gh release create` is configured to push, and there's no harm in keeping artefacts off the source repo's Releases page (it's a cleanliness thing now, not a privacy thing). Doc references to "private repo" in `README.md`, `docs/RELEASES.md` § "Why two repos?", and `CONTRIBUTING.md` are now stale and should be updated in a follow-up doc commit; they don't affect runtime behaviour.

**Convention check.** Pure additive — one welcome-view rewrite, one Tauri command edit, version bump. No new dependencies. No orchestrator code touched. Reversal: `git revert <r9 commit>`. Operators on v0.1.6 who downgrade to v0.1.5 manually would see the broken `gh repo clone` CTA again — but the welcome window itself still works; only the auto-staged Terminal command is wrong.

**Recovery tag:** `pre-r9-2026-05-08`.

---

## 2026-05-07

### Phase 2 / Release pipeline — R.8 (welcome CTA fix — source-repo-honest one-liner) → v0.1.5

Patch on top of R.7's welcome window. Don tested v0.1.4 on his external iMac and hit a 404 on `npx claw-setup` — the CTA we shipped pointed at an npm package that has never been published (the wizard at `cli/claw-setup/` has `"private": true` in its package.json). R.7 baked in the misleading command. R.8 fixes it.

**Choice locked: Path A** (keep wizard private, fix the welcome's framing) over Path B (publish wizard publicly). Path A is honest about the prerequisite — the wizard provisions a Factotem deployment from a clone of the (private) source repo, so source-repo access is genuinely required regardless of whether the wizard's npm package is published. Path C (truly self-contained operator-friendly install) is deferred to a future arc.

**Files changed.**

- `package.json` (orchestrator root) — new top-level `claw-setup` script:
  ```
  cd cli/claw-setup && npm install --silent && npm run build --silent && cd ../.. && node cli/claw-setup/dist/index.js
  ```
  Wraps the wizard's install + build + run in one command. Maintainers with the source repo cloned can now run `npm run claw-setup` from the repo root and start the wizard.
- `cli/claw-doctor/src/views/WelcomeView.tsx` — setup-state card rewritten:
  - Lead text now states the prerequisite explicitly: "Setting one up requires source-repo access — the wizard provisions from a clone of `donkruger/factotem` (a private repo)."
  - The displayed command is the realistic one-liner: `gh repo clone donkruger/factotem && cd factotem && npm run claw-setup`. Copy + Open Terminal buttons stage that exact command.
  - New "Don't have access yet?" callout below the hint, pointing operators at their Factotem maintainer + reassuring them the Doctor will keep running regardless.
  - Added monospace styling for inline `<code>` references in the prereq paragraph.
- `cli/claw-doctor/src-tauri/src/commands.rs` — `open_setup_in_terminal` AppleScript updated to stage the new one-liner. The function's docstring now explains the prerequisite (gh CLI authenticated as a user with access to `donkruger/factotem`).
- `cli/claw-doctor/{package.json,package-lock.json,src-tauri/Cargo.toml,src-tauri/Cargo.lock,src-tauri/tauri.conf.json}` — version 0.1.4 → 0.1.5.
- `docs/RELEASES.md` — upgrade-path table extended with the v0.1.4 → v0.1.5 row, noting the welcome CTA fix.
- `docs/CHANGE_LOG.md` — this entry.

**Verification (live on Don's machine).**

- v0.1.5 installed at `/Applications/Factotem Doctor.app`, running PID 40168, single instance.
- Welcome window auto-opened on first launch (settings file removed pre-install). State A card visible because Don's main machine has NanoClaw running.
- `npm run claw-setup` from the repo root invokes the wizard correctly (verified by the script's resolved path: `cd cli/claw-setup && npm install ... && node cli/claw-setup/dist/index.js`).
- The Open Terminal helper now stages `gh repo clone donkruger/factotem && cd factotem && npm run claw-setup` — confirmed by inspecting `commands.rs::open_setup_in_terminal`. Don's external iMac test would now run a working command (assuming `gh` is installed and authenticated as a user with access).

**Convention check.** Pure additive — one new orchestrator script, one welcome-view rewrite, one Tauri command edit, one doc update. No new dependencies. No orchestrator code touched. Reversal: `git revert <r8 commit>`. Operators on v0.1.5 who downgrade to v0.1.4 manually would see the broken `npx claw-setup` CTA again — but they can manually run `npm run claw-setup` from inside the repo as a workaround until they re-upgrade.

**Recovery tag:** `pre-r8-2026-05-07`.

---

### Phase 2 / Release pipeline — R.7 (first-run UX + state-aware Doctor) → v0.1.4

Closes the UX gaps Don found while testing v0.1.3 on a clean device with no NanoClaw orchestrator. Six changes shipping together as v0.1.4 — every operator-visible failure mode from that test session now has a friendly path through it.

**1. Single-instance enforcement.** Added `tauri-plugin-single-instance = "2"`. Wired BEFORE other plugins in `lib.rs`'s builder chain so it gates the entire app. The duplicate tray icon Don observed (autostart's launchd `RunAtLoad` spawning instance 2 from a stale `target/release/bundle/...` path while instance 1 ran from `/Applications/`) is now eliminated regardless of how the duplicate spawn happened. The second instance calls into a closure that focuses any open Doctor window and exits cleanly.

**2. First-run welcome window.** New `WelcomeView.tsx` (~330 lines, two states):
- **A. Stack detected** — "Welcome. The Factotem Doctor lives in your menu bar. Click the F icon for status." Animated arrow points up at the menu bar. Single Got it CTA.
- **B. Stack not installed** — same intro, then a setup card: copy-to-clipboard `npx claw-setup` + a primary button that opens Terminal.app pre-staged with the command (operator confirms with Enter — Doctor never auto-executes wizard mutations).

`lib.rs` opens `?view=welcome` automatically when `settings.first_run_completed == false`. New settings field `first_run_completed: bool` (`#[serde(default)]` so existing settings files migrate transparently) flips to true on Got it via the new `dismiss_welcome` command. Subsequent launches don't auto-open the welcome.

**3. New probe state `OverallStatus::NotInstalled`.** `probe.rs::synthesize_overall` gains a branch BEFORE the Red checks: when zero NanoClaw processes + zero `com.nanoclaw*` launchd labels (excluding `com.nanoclaw.oauth-refresh`) + no port :7842 owner, the probe returns `NotInstalled` instead of conflating with Red. Tray icon dot is blue (informational, not alarmed); headline reads "NanoClaw not installed".

**4. Contextual menu labels.** `tray.rs::build_status_menu` now adapts to state:

| Item | Configured (Green/Amber/Red) | NotInstalled |
|---|---|---|
| Open Dashboard | Enabled, gated on `nanoclaw_http.ok` | Disabled, label reads "Open Dashboard (NanoClaw not installed)" |
| Repair Stack… | Enabled (typed-confirm-gated) | **Replaced by "Set up NanoClaw…"** which opens the welcome window |
| View NanoClaw logs… | Enabled when log path resolves | Disabled, label "View NanoClaw logs (no log file yet)" |
| Open Recovery Panel | Enabled (always — see below) | Enabled |
| Settings… | Enabled | Enabled |

The "Set up NanoClaw…" item gives operators a permanent re-entry point to the welcome window's setup-mode card, even after they've dismissed the first-run welcome.

**5. Bundled `recovery.html`.** The Doctor now ships with a copy of `scripts/recovery/recovery.html` at `Contents/Resources/recovery.html` inside the .app, via `tauri.conf.json`'s `bundle.resources`. `commands.rs::open_recovery_panel` falls back through three sources:

1. Operator-installed copy at `~/Library/Application Support/Factotem/recovery.html` (placed by `scripts/install-recovery.sh`; possibly customised per deployment).
2. Bundled copy at `Resources/recovery.html` inside the .app — works on completely fresh machines without the orchestrator installed.
3. Last-resort: GitHub URL.

This kills the "Open Recovery Panel falls back to opening a GitHub markdown file" UX failure on fresh installs.

**6. Stale-plist remediation.** New `lib.rs::remediate_stale_plist` runs at startup (when `launch_at_login: true`):

1. Reads `~/Library/LaunchAgents/Factotem Doctor.plist` if present.
2. Extracts `ProgramArguments[0]` via `plutil -extract`.
3. Compares to `std::env::current_exe()`.
4. If mismatched, calls `manager.disable() → manager.enable()` to regenerate the plist with the right path.

Operators upgrading from v0.1.3 (where the plist might point at `target/release/bundle/...`) automatically get the plist fixed on first v0.1.4 launch — no operator action required.

**Verification (live on Don's machine).**

- `bash scripts/install-doctor.sh --verify` → installed copy v0.1.4, single PID 22501, autostart agent registered.
- `pgrep -fl factotem-doctor` → exactly **one** PID (was two on stale-plist installs before single-instance plugin landed).
- `plutil -extract ProgramArguments.0 raw -o - "~/Library/LaunchAgents/Factotem Doctor.plist"` → returns `/Applications/Factotem Doctor.app/Contents/MacOS/factotem-doctor` (was `target/release/...` pre-R.7 — confirmation that stale-plist remediation worked).
- `spctl --assess --type execute --verbose=2 "/Applications/Factotem Doctor.app"` → `accepted; source=Notarized Developer ID`.
- `ls "Contents/Resources/recovery.html"` inside the .app → 12.3 KB, present.
- Welcome window auto-opened on first launch (operator-side visual confirmation pending).

**Files changed.**

```
NEW   cli/claw-doctor/src/views/WelcomeView.tsx                 ~330 lines (UI + scoped CSS)
M     cli/claw-doctor/src-tauri/Cargo.toml                      + tauri-plugin-single-instance, version 0.1.4
M     cli/claw-doctor/src-tauri/Cargo.lock                      refresh
M     cli/claw-doctor/src-tauri/tauri.conf.json                 + bundle.resources, version 0.1.4
M     cli/claw-doctor/src-tauri/capabilities/default.json       + welcome window
M     cli/claw-doctor/src-tauri/src/settings.rs                 + first_run_completed
M     cli/claw-doctor/src-tauri/src/probe.rs                    + OverallStatus::NotInstalled + synthesis branch
M     cli/claw-doctor/src-tauri/src/tray.rs                     + SETUP_NANOCLAW menu id; contextual labels per state
M     cli/claw-doctor/src-tauri/src/commands.rs                 + 3 commands + recovery.html fallback chain + open_welcome_window helper
M     cli/claw-doctor/src-tauri/src/lib.rs                      + single-instance plugin + first-run auto-open + stale-plist remediation
M     cli/claw-doctor/src/lib/tauri.ts                          + StackStatus types + 4 new wrappers
M     cli/claw-doctor/src/main.tsx                              + welcome route
M     cli/claw-doctor/{package.json,package-lock.json}          version 0.1.4
M     docs/RELEASES.md                                          upgrade-path table updated
M     docs/CHANGE_LOG.md                                        this entry
```

**Convention check.** Pure additive — new dependency (`tauri-plugin-single-instance`), one new probe variant, one new settings field with `serde(default)`, three new commands, one new React view. No orchestrator code touched. No Sensitive-functionality-list touch. Reversal is `git revert <r7 commit>`. Operators on v0.1.4 who downgrade to v0.1.3 (manually) get the old behaviour back; the `first_run_completed` field is silently ignored on v0.1.3 thanks to `serde`'s default tolerance.

**Recovery tag:** `pre-r7-2026-05-07`.

R.7 also marks the first time we exercise the live auto-update round-trip: the running v0.1.3 Doctor will detect v0.1.4 once CI publishes it to `RichardBNel/Factotem`, then operators can install via the in-app banner.

---

### Phase 2 / Release pipeline — R.6 (stable download URL + asset clarity)

Small follow-up to R.5 once Don saw the v0.1.3 release page. Two operator-experience improvements:

1. **A stable single-click download URL.** The README now opens with a prominent download CTA pointing at `https://github.com/RichardBNel/Factotem/releases/latest/download/Factotem-Doctor.dmg` — a constant URL that always redirects to the latest release's `.dmg`. GitHub's `/releases/latest/download/<filename>` redirect requires the filename to be **constant across releases**, so versioned filenames (`Factotem-Doctor_0.1.3_aarch64.dmg`) don't work for the pattern. The fix: add a versionless copy of the .dmg to every release alongside the versioned one. The workflow's "Stage release artefacts" step now copies the source DMG to both `Factotem-Doctor_${VERSION}_aarch64.dmg` (for archival / specific-version downloads) AND `Factotem-Doctor.dmg` (for the stable URL). `gh release upload` was used to retroactively add `Factotem-Doctor.dmg` to v0.1.3 so the URL works immediately, without waiting for the next release.

2. **Disambiguate the auto-attached "Source code" archives.** GitHub auto-attaches `<repo>/archive/refs/tags/<tag>.zip` to every release. These cannot be removed via API. Operators reading the v0.1.3 release page wondered whether those archives leak the private source. They don't: the mirror repo (`RichardBNel/Factotem`) has only a README — verified via `curl https://github.com/RichardBNel/Factotem/archive/refs/tags/v0.1.3.zip` which extracts to a single 1,225-byte README. The mirror's README has been expanded to make this explicit ("About the 'Source code' archives — these only contain this README"). RELEASES.md's asset inventory now calls this out too.

**Files changed.**

- `.github/workflows/release.yml` — `Stage release artefacts` step now produces a versionless `Factotem-Doctor.dmg` alongside the versioned one (one extra `cp`).
- `README.md` — new download CTA at the top with the stable URL + a sub-link to all-versions and to `docs/RELEASES.md`.
- `docs/RELEASES.md`:
  - New "Stable download URL" subsection at the top (operator-first).
  - "Asset inventory" table reformatted to show 5 files (was 4) and a clear "Operator downloads this?" column.
  - "Asset naming" section in the conventions documents the versionless DMG convention + the future-Intel caveat (versionless filenames can't disambiguate architecture).
- `RichardBNel/Factotem` mirror's `README.md` (separate commit on the mirror repo): added the stable download CTA + an "About the 'Source code' archives" section that demystifies the auto-attached files.
- `docs/CHANGE_LOG.md` — this entry.

**Operator experience after R.6.**

1. Land on the README → see the download CTA at the top → click → `.dmg` downloads.
2. Open .dmg → drag .app to /Applications → eject.
3. Click the menu-bar icon → Doctor running, autostart registered.
4. Future releases auto-detect via the in-app updater; no further manual downloads needed.

**Convention check.** Pure additive — workflow gains one extra `cp`; doc changes are pure additions; the mirror repo's README is the only commit on a public-visible surface and contains no secrets. Reversal: drop the `cp "$DMG_SRC" "$DMG_LATEST"` line in the workflow + revert the docs. The retroactively-uploaded `Factotem-Doctor.dmg` on v0.1.3 can stay or be removed via `gh release delete-asset`.

**Recovery tag:** `pre-r6-2026-05-07`.

---

### Phase 2 / Release pipeline — R.5 (public mirror to RichardBNel/Factotem) → v0.1.3

Closes the visibility gate flagged in R.3+R.4. Source repo (`donkruger/factotem`) stays private; release artefacts mirror to **`RichardBNel/Factotem`** (public, Don has write access, zero existing releases — clean slate). The Tauri updater now polls the public mirror's `latest.json`, so unauthenticated clients (the running Doctor) can resolve the URL. Operator-approved auto-update flow now functional end-to-end.

**Two-repo model:**

| Repo | Visibility | Purpose |
|---|---|---|
| `donkruger/factotem` | Private | Source of truth. CI builds here. Tags pushed here. CHANGE_LOG + plans + integration code stay out of public view. |
| `RichardBNel/Factotem` | Public | Release-only mirror. Holds `.dmg` + `.app.tar.gz` + `.app.tar.gz.sig` + `latest.json`. Source code never lands here — only release assets via `gh release create --repo RichardBNel/Factotem`. |

**Files changed.**

- `.github/workflows/release.yml`:
  - Added `env.MIRROR_REPO: RichardBNel/Factotem` at workflow level.
  - The `Generate latest.json` step uses `os.environ['MIRROR_REPO']` for the embedded download URL (so the manifest the Doctor downloads points at the public mirror, not the private source).
  - The `Create GitHub Release` step renamed to "Create GitHub Release on public mirror"; uses `--repo "$MIRROR_REPO"` and `GH_TOKEN: ${{ secrets.MIRROR_REPO_TOKEN }}` (the default `GITHUB_TOKEN` is scoped to the source repo and can't write across repos).
- `cli/claw-doctor/src-tauri/tauri.conf.json`:
  - `plugins.updater.endpoints` flipped to `https://github.com/RichardBNel/Factotem/releases/latest/download/latest.json`.
- `scripts/install-doctor.sh`:
  - GitHub Release fallback now downloads from `RichardBNel/Factotem` (worked before only with auth on the private source; now public + unauthenticated).
- `docs/RELEASES.md`:
  - Download path updated.
  - New "Why two repos?" section explaining the visibility split.
  - Maintainer runbook updated for cross-repo verification (`gh release view --repo RichardBNel/Factotem`).
- `README.md` — Releases section points at the public mirror.
- Version bumped 0.1.2 → 0.1.3 in `package.json`, `package-lock.json`, `Cargo.toml`, `Cargo.lock`, `tauri.conf.json`.
- `docs/CHANGE_LOG.md` — this entry.

**Operator-side setup (one-off).**

- Created `MIRROR_REPO_TOKEN` GitHub Actions secret on `donkruger/factotem`. Source: Don's existing `gh auth token` (classic PAT with `repo` scope). The token has `push: true` on `RichardBNel/Factotem` (verified via `gh api repos/RichardBNel/Factotem --jq '.permissions'`).
- The two pre-existing releases (`v0.1.1`, `v0.1.2`) on `donkruger/factotem` remain — operator can `gh release delete` them later if archival isn't useful. They were never reachable publicly, so no harm leaving them.

**Verification (post-tag).**

1. `git tag v0.1.3 && git push origin v0.1.3` triggers CI.
2. Workflow builds, signs, notarises, generates `latest.json`, then `gh release create --repo RichardBNel/Factotem v0.1.3 ...` lands the assets on the public mirror.
3. `curl -sI https://github.com/RichardBNel/Factotem/releases/latest/download/latest.json` returns `HTTP 200` (no auth required — public repo).
4. Running v0.1.2 Doctor's "Check now" button detects v0.1.3, renders the Settings banner, and installing replaces /Applications with v0.1.3 + restart.

**Convention check.** Pure additive — workflow change + endpoint change + docs. The two-repo split is operationally lightweight (one cross-repo token, one push step). Reversal: `git revert <commit>` reverts the endpoint flip; release artefacts on the public mirror persist until manually deleted. No orchestrator code touched.

**Recovery tag:** `pre-r5-2026-05-07`.

**Phase 2 fully closed.** R.1 (plumbing) → R.2 (workflow + first private release) → R.3 (operator UI) → R.4 (docs) → R.5 (public mirror). Auto-update is functional; v0.1.3 is the first version operators can detect-and-install via the public update path.

---

### Phase 2 / Release pipeline — R.3 + R.4 (operator-approved update UI + docs) → v0.1.2

Closes Phase 2. R.3 adds the operator-visible update flow inside the Doctor (background poll, system notification on detection, Settings banner with Install button, manual "Check now" trigger). R.4 documents the release model end-to-end. Together these ship as **v0.1.2** — the first version where operators see updates land themselves rather than learning about them out of band.

**R.3 — Update detection + UI.**

- `cli/claw-doctor/src-tauri/src/settings.rs` — added two fields with `#[serde(default)]` so existing settings files load cleanly: `auto_check_updates: bool` (default true), `last_update_check_at: Option<String>`.
- `cli/claw-doctor/src-tauri/src/lib.rs` — new `run_update_check_loop` task spawned at startup. Polls every 4 hours via `UpdaterExt::check`. Honours `auto_check_updates`. On detection, fires three signals: a Tauri event `update-available`, a system notification ("Factotem Doctor vX.Y.Z available — Open Settings → Updates to install"), and an updated `last_update_check_at` persisted to disk.
- `cli/claw-doctor/src-tauri/src/commands.rs` — added `get_current_version()` Tauri command.
- `cli/claw-doctor/src/lib/tauri.ts` — new typed wrappers: `getCurrentVersion`, `checkForUpdates`, `installUpdateAndRestart`, `onUpdateAvailable` (event subscription).
- `cli/claw-doctor/src/views/SettingsView.tsx` — new "Updates" section: current-version display, auto-check toggle, "Last checked Xm ago" text, "Check now" button. Plus a prominent banner at the top of Settings when an update is detected: release notes + "Install + restart now" / "Later" buttons. Banner subscribes to `update-available` so a new release detected while Settings is open appears immediately without polling.

The four-hour cadence is deliberately conservative — operators can hit "Check now" any time, and we don't want to spam GitHub. Tighter cadences would be wasteful: the typical release cycle is days-to-weeks, not hours. Once shipped, this becomes adjustable via Settings if operators ask.

**R.4 — Documentation + installer fallback.**

- **NEW** `docs/RELEASES.md` — end-to-end operator + maintainer guide. Covers download paths, the four files in each release, the auto-update flow step-by-step, manual downgrade procedure, the maintainer tag-and-publish runbook (bump 5 version locations, commit, tag, watch CI), and the trust model (Apple Dev ID + Tauri ed25519 separation).
- `README.md` — Phase 2 added to the status table; new "Releases" section pointing operators at GitHub Releases.
- `docs/SETUP_WIZARD.md` — extended the "Factotem Doctor (Phase 1)" subsection to describe the install source order (local bundle → GitHub Release fallback → skip with warning).
- `scripts/install-doctor.sh` — new fallback path: if the local source bundle is missing AND `gh` is installed + authenticated, the script downloads the latest `.dmg` from `donkruger/factotem` releases, mounts it, dittos the .app to a temp dir, detaches the DMG, and installs from there. Operators who clone the repo without building (e.g. for the Doctor only, no Rust toolchain) get a working install.

**Version bumped.** 0.1.1 → 0.1.2 in `package.json`, `package-lock.json`, `Cargo.toml`, `Cargo.lock`, and `tauri.conf.json`. Tagging `v0.1.2` after this commit lands triggers the second CI release.

**Cross-version compatibility.**

| Running version | Detects updates? | Update UI visible? |
|---|---|---|
| v0.1.0 (M1.6 + earlier) | No (no updater plugin) | No |
| v0.1.1 (R.1 + R.2) | No (no auto-poll loop) | No (commands exist but no UI) |
| **v0.1.2** (R.3) | Yes — auto every 4h + manual "Check now" | Yes — banner + Settings section |

Operators on v0.1.0 or v0.1.1 install v0.1.2 manually (drag from .dmg). From v0.1.2 onwards it's automatic. Documented in `docs/RELEASES.md` § "How to upgrade an existing install."

**Files changed.**

```
NEW   docs/RELEASES.md                                                       ~150 lines
M     README.md                                                              + Phase 2 row + Releases section
M     docs/SETUP_WIZARD.md                                                   + install source order
M     scripts/install-doctor.sh                                              + gh release download fallback
M     cli/claw-doctor/src-tauri/src/settings.rs                              + 2 fields
M     cli/claw-doctor/src-tauri/src/lib.rs                                   + update poll loop + notification helper
M     cli/claw-doctor/src-tauri/src/commands.rs                              + get_current_version
M     cli/claw-doctor/src/lib/tauri.ts                                       + 4 wrappers + event subscription
M     cli/claw-doctor/src/views/SettingsView.tsx                             + banner + Updates section + CSS
M     cli/claw-doctor/package.json + package-lock.json                       v0.1.2
M     cli/claw-doctor/src-tauri/Cargo.toml + Cargo.lock                      v0.1.2
M     cli/claw-doctor/src-tauri/tauri.conf.json                              v0.1.2
M     docs/CHANGE_LOG.md                                                     this entry
```

**Convention check.** Pure additive — new fields with `serde(default)` so old settings files migrate transparently; new commands; new UI section. No orchestrator code touched. The poll loop is independent of the probe loop; either can fail without affecting the other. Reversal: `git revert <commit>` removes everything; the on-disk Doctor at /Applications stays put until the operator manually reinstalls.

**Phase 2 complete (with one operator decision pending).** R.1 (plumbing) → R.2 (CI + first release) → R.3 (operator-approved UI) → R.4 (docs). The Doctor is now a self-updating macOS app with a transparent operator approval gate at every install step.

**⚠ Repo visibility gate.** The Tauri updater polls `https://github.com/donkruger/factotem/releases/latest/download/latest.json`. As of this commit, that URL returns 404 because `donkruger/factotem` is a **private repo** — public asset download URLs don't resolve for private repos. Three resolution paths:

1. **Make the repo public** — the simplest fix; the workflow + URLs work as designed for "anyone can auto-update." Nothing committed contains secrets (the keypair + Apple cert live in GitHub Actions secrets or in iCloud, never in the repo). Don's call.
2. **Operate with authenticated downloads** — Tauri updater supports custom HTTP headers via a builder configuration; operators each need a GitHub token in their environment. Defeats the "anyone" goal.
3. **Mirror releases to a separate public repo** — publish `latest.json` + the .tar.gz to `donkruger/factotem-releases` (public) while keeping `donkruger/factotem` (private). More overhead but preserves source-code privacy.

The R.1–R.4 code is correct and ships regardless; the operator-visible flow waits on the visibility decision. v0.1.1 release assets are uploaded and discoverable via `gh release download` (authenticated); auto-update detection just doesn't trigger until the public URL resolves.

**Recovery tag:** `pre-r3-2026-05-07`.

---

### Phase 2 / Release pipeline — R.2 (GitHub Actions release workflow + v0.1.1)

Second of four. R.1 added the in-app updater plumbing; R.2 publishes the first release. Tagging `v0.1.1` triggers a macOS-14 GitHub Actions workflow that builds, signs, notarises, and publishes the .dmg + .app.tar.gz + .app.tar.gz.sig + latest.json as release assets — operators can download from `https://github.com/donkruger/factotem/releases/latest` from this point forward.

**New: `.github/workflows/release.yml`.** Triggered on tags matching `v*`. macOS-14 runner (Apple Silicon — produces aarch64 binaries; x86_64 + universal binaries are a future build matrix expansion). Steps:

1. Checkout + Node 20 + Rust stable + cargo-tauri install.
2. Import the Apple Developer ID `.p12` from `APPLE_CERT_BASE64` into a temporary keychain scoped to the run (auto-cleaned on `if: always()` cleanup step at the end).
3. `npm ci` in the Doctor frontend.
4. `cargo tauri build` with the Apple + Tauri signing env vars set. Produces signed + notarised `.app`, signed `.dmg`, plus `.app.tar.gz` + `.app.tar.gz.sig` updater artefacts.
5. Notarise + staple the DMG separately (Tauri 2 quirk — its bundler signs but doesn't auto-notarise the DMG; documented in M1.5).
6. Stage artefacts with URL-safe names (`Factotem-Doctor_X.Y.Z_aarch64.dmg` rather than `Factotem Doctor_X.Y.Z_aarch64.dmg` with a space).
7. Generate `latest.json` — Tauri's update manifest format. Embeds the version, the latest CHANGE_LOG entry as release notes, the .tar.gz signature contents (NOT a URL — the literal base64 minisign signature), and the public download URL.
8. Verify Gatekeeper acceptance via `spctl --assess` (logs warning rather than failing the build).
9. `gh release create` — uploads .dmg + .app.tar.gz + .app.tar.gz.sig + latest.json to the release; uses the latest CHANGE_LOG entry as the release notes; flagged `--latest` so the updater plugin's `releases/latest/download/latest.json` URL resolves correctly.
10. Cleanup keychain.

**GitHub Actions secrets** (8, set once via `gh secret set`):

| Secret | Source |
|---|---|
| `APPLE_CERT_BASE64` | `base64 < KanbanPro-DeveloperID.p12` (team-wide cert; same one signs the Doctor) |
| `APPLE_CERT_PASSWORD` | .p12 passphrase |
| `APPLE_SIGNING_IDENTITY` | "Developer ID Application: Don Kruger (D8G67T74V6)" |
| `APPLE_ID` | Apple ID for notarytool |
| `APPLE_PASSWORD` | App-specific password |
| `APPLE_TEAM_ID` | D8G67T74V6 |
| `TAURI_SIGNING_PRIVATE_KEY` | Ed25519 private key generated in R.1 |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Empty (key was generated without a passphrase) |

**Version bumps.** `cli/claw-doctor/package.json`, `cli/claw-doctor/package-lock.json`, `cli/claw-doctor/src-tauri/Cargo.toml`, and `cli/claw-doctor/src-tauri/tauri.conf.json` all bumped from 0.1.0 → 0.1.1. `cargo check` refreshed `Cargo.lock`; `npm install --package-lock-only` refreshed `package-lock.json`.

**Files changed.**

- **NEW** `.github/workflows/release.yml` — ~150 lines, single-job workflow on `macos-14`.
- `cli/claw-doctor/package.json` — version 0.1.1.
- `cli/claw-doctor/package-lock.json` — version 0.1.1.
- `cli/claw-doctor/src-tauri/Cargo.toml` — version 0.1.1.
- `cli/claw-doctor/src-tauri/Cargo.lock` — version 0.1.1.
- `cli/claw-doctor/src-tauri/tauri.conf.json` — version 0.1.1.
- `docs/CHANGE_LOG.md` — this entry (extracted as v0.1.1 release notes by the workflow).

**Verification (post-tag).**

1. `git tag v0.1.1 && git push origin v0.1.1` triggers the workflow.
2. Workflow takes ~10–15 minutes (Tauri build + Apple notarisation queue + DMG re-notarisation).
3. `gh release view v0.1.1 --repo donkruger/factotem` shows three asset files: `.dmg`, `.app.tar.gz`, `.app.tar.gz.sig`, plus `latest.json`.
4. `curl -sI https://github.com/donkruger/factotem/releases/latest/download/latest.json` returns 200 with the manifest.
5. Downloading the `.dmg`, mounting, copying to /Applications, running `spctl --assess` confirms Notarized Developer ID acceptance.

**Convention check.** Pure additive — one new workflow file, four version bumps, one CHANGE_LOG entry. No code changes to the orchestrator, Doctor, or wizard. The cert + tokens live as GitHub Actions secrets, never committed. Reversal: `gh release delete v0.1.1 --yes && git tag -d v0.1.1 && git push origin :v0.1.1`. The workflow file can be reverted independently.

**Recovery tag:** `pre-r2-2026-05-07`.

R.3 follows: operator-approved update UI in the Doctor (auto-check toggle, banner, install/restart flow).

---

### Phase 2 / Release pipeline — R.1 (Tauri updater plumbing in the Doctor)

First of four sequential milestones that turn the Doctor into an auto-updateable artifact distributed via GitHub Releases. R.1 adds the in-app plumbing without changing operator-visible behaviour — the Doctor now contains the updater plugin and three Tauri commands, but doesn't poll for updates yet (R.3 wires the operator-approved scheduler).

**Updater keypair generated.** Ed25519 keypair generated via `cargo tauri signer generate`, separate from the Apple Developer ID certificate (different threat model — Gatekeeper trust vs. in-app update integrity). Private key saved to `~/Library/Mobile Documents/com~apple~CloudDocs/Keychain Certificates/Factotem/factotem-doctor-updater.key` (iCloud Keychain Certificates folder, alongside KanbanPro's .p12 — same convention). Public key embedded in `tauri.conf.json plugins.updater.pubkey`. The private key is **not committed**; it lives in iCloud + will land as a GitHub Actions secret in R.2.

**Files changed.**

- `cli/claw-doctor/src-tauri/Cargo.toml` — added `tauri-plugin-updater = "2"`.
- `cli/claw-doctor/src-tauri/tauri.conf.json` — new `plugins.updater` block with the pubkey + the GitHub Releases endpoint (`https://github.com/donkruger/factotem/releases/latest/download/latest.json`); `bundle.createUpdaterArtifacts: true` so the build produces the `.app.tar.gz` + `.app.tar.gz.sig` pair the updater plugin consumes.
- `cli/claw-doctor/src-tauri/capabilities/default.json` — added `updater:default` permission.
- `cli/claw-doctor/src-tauri/src/lib.rs` — `.plugin(tauri_plugin_updater::Builder::new().build())` in the builder chain; new commands wired through `invoke_handler`.
- `cli/claw-doctor/src-tauri/src/commands.rs` — two new Tauri commands:
  - `check_for_updates()` — calls `UpdaterExt::check()`, returns a serialisable `UpdateInfo` DTO (version, current version, date, body) or `None` when up-to-date.
  - `install_update_and_restart()` — downloads + verifies signature + replaces /Applications/Factotem Doctor.app + calls `app.restart()`. Single atomic operation from the operator's POV.
- `docs/CHANGE_LOG.md` — this entry.

The updater plugin's signature verification uses the ed25519 pubkey in tauri.conf.json. CI (R.2) will sign each release's `.tar.gz` with the matching private key from a GitHub Actions secret; a release with an invalid signature is rejected before install. Two layers of trust now: Apple Dev ID + notarisation (Gatekeeper, OS-level) AND ed25519 signature (in-app update integrity, app-level).

**Build verification.** `cargo tauri build` with `APPLE_*` + `TAURI_SIGNING_PRIVATE_KEY` env vars produces:

```
Factotem Doctor.app                      (signed + notarised + stapled)
Factotem Doctor_0.1.0_aarch64.dmg        (signed)
Factotem Doctor.app.tar.gz               (updater payload)
Factotem Doctor.app.tar.gz.sig           (ed25519 signature)
```

Notarisation Accepted (id 5ed92ca1-…). The new build was NOT installed to /Applications — the running M1.6 Doctor (v0.1.0, PID 31969) stays in place. R.2 will tag v0.1.1 and CI will produce the first auto-updateable release; operators manually install v0.1.1 to bridge the gap (the running v0.1.0 doesn't have the updater plugin and so can't auto-detect future releases).

**Convention check.** Pure additive — one new dependency, three modified config files, two new commands, one CHANGE_LOG entry. No orchestrator code touched. No operator-visible behaviour change. Reversal is `git revert <commit>`. The keypair in iCloud is operator-side state, not committed.

**Recovery tag:** `pre-r1-2026-05-07`.

R.2 follows: GitHub Actions workflow + first signed release (`v0.1.1`).

---

### Phase 1 / Tauri Doctor — M1.6 (claw-setup wizard installs the Doctor to /Applications)

Sixth and final execution session of Phase 1. M1.5 produced the signed + notarized .app earlier today, but operators still had to find it manually under `cli/claw-doctor/src-tauri/target/release/bundle/macos/` and `open` it themselves. M1.6 closes that gap: the cold-start wizard now installs the Doctor at the end of every fresh `npx claw-setup` run, so a brand-new Bob Mac Mini (or Mark's laptop) goes from "nothing" to "menu-bar Doctor running, autostart registered, ready to repair the stack" in one continuous flow.

**New: `nanoclaw/scripts/install-doctor.sh`.** Standalone installer mirroring `scripts/install-recovery.sh`. Three modes: `install` (default), `--uninstall`, `--verify`. Re-runnable independently of the wizard for upgrades on existing deployments.

Install logic:

1. macOS-only guard.
2. Resolve source: `<repo-root>/cli/claw-doctor/src-tauri/target/release/bundle/macos/Factotem Doctor.app`. If absent, exits 1 with `cd cli/claw-doctor && cargo tauri build` instructions.
3. If a `Factotem Doctor.app` already exists at `/Applications` with a `CFBundleIdentifier` other than `co.factotem.doctor`, refuses to overwrite (guards against an unrelated app with the same display name).
4. `pkill -9 -f factotem-doctor` to stop any running instance — copying over a live .app produces partial writes on macOS.
5. `ditto` the source to `/Applications/Factotem Doctor.app` (preserves resource forks + xattrs better than `cp -R`).
6. `xattr -dr com.apple.quarantine` to strip the quarantine bit (the .app is notarized so Gatekeeper would accept it anyway, but a stray quarantine attribute would trigger a one-time confirm dialog).
7. `open` to launch — fire-and-forget, tray icon appears within ~2s.

Uninstall: kills running process, removes `/Applications/Factotem Doctor.app`, unloads + removes `~/Library/LaunchAgents/Factotem Doctor.plist` (the autostart agent registered by tauri-plugin-autostart in M1.4), removes `~/Library/Application Support/Factotem/doctor-settings.json`. Idempotent.

Verify: read-only check. Prints state of source bundle, installed copy, running process, autostart agent, settings file.

**Modified: `cli/claw-setup/src/steps/11-handoff.ts`.** Added a second best-effort install block parallel to the existing recovery-panel install (which has lived in this step since session 1 of Phase 1). Same try/catch shape, same `ui.warn` on failure, same "never fail the wizard" promise. The cheat-sheet printed at the end now includes a Doctor section when `doctorInstalled === true`:

```
Factotem Doctor:
  /Applications/Factotem Doctor.app — running in your menu bar
  Click the icon for: Open Dashboard, Repair Stack, Settings, Logs
  Tooltip refreshes every 5s with Docker / OneCLI / NanoClaw health
```

Repo-root resolution was hoisted up so both installer invocations share the same path computation. No new step file, no re-numbering — keeps the diff small and the existing 12-step layout uniform.

**Modified: `docs/SETUP_WIZARD.md`.** New "Factotem Doctor (Phase 1)" section documenting the wizard install + the standalone installer + the three modes. Step-list table entry for `11-handoff` updated to reflect the Doctor install.

**Live verification (Don's machine, post-M1.6):**

- `bash scripts/install-doctor.sh --verify` (pre-install): source bundle ✓ (v0.1.0), installed copy ✗ not installed, running process ✓ PID 93796 (M1.5 build from `target/release/`), autostart agent ✓ registered.
- `bash scripts/install-doctor.sh` (install): killed PID 93796 → `ditto` to `/Applications` → strip quarantine → relaunched as PID 31969.
- `bash scripts/install-doctor.sh --verify` (post-install): installed copy ✓ `/Applications/Factotem Doctor.app (v0.1.0)`, running process ✓ PID 31969, autostart agent ✓ preserved.
- `spctl --assess --type execute --verbose=2 "/Applications/Factotem Doctor.app"`: `accepted; source=Notarized Developer ID` — `ditto` preserved the M1.5 notarization stamp.
- `npm run build` in `cli/claw-setup/` — TypeScript compile passed.
- Path resolution check: from `cli/claw-setup/dist/steps/11-handoff.js`, `path.resolve(..., '..', '..', '..', '..', 'scripts', 'install-doctor.sh')` resolves to the correct repo-root location and `fs.existsSync` returns true.

**Files changed:**

```
NEW   nanoclaw/scripts/install-doctor.sh                ~210 lines, executable
M     nanoclaw/cli/claw-setup/src/steps/11-handoff.ts   (+~30 lines: best-effort install block + cheat-sheet section)
M     nanoclaw/docs/SETUP_WIZARD.md                     (+~30 lines: Factotem Doctor subsection)
M     nanoclaw/docs/CHANGE_LOG.md                       (this entry)
```

Note: the wizard's compiled JS under `cli/claw-setup/dist/` is not committed (gitignored); operators run `npm run build` after install or use the prebuilt npm package.

**Convention check.** Pure additive — one new shell script + one extended TypeScript step + two doc files. No orchestrator code touched. No Sensitive-functionality-list touch. Reversal: `git revert <m1.6 commit>` removes the new script + the wizard extension + the docs. The `/Applications/Factotem Doctor.app` installed today persists until the operator runs `bash scripts/install-doctor.sh --uninstall`.

**Phase 1 complete.** M1.1 + M1.2 (scaffold + multi-instance probe) → M1.3 (Repair Stack) → M1.4 (Settings + Logs) → M1.5 (signing + notarization) → M1.6 (wizard integration). The Factotem Doctor is now an end-to-end shipped product: any fresh deployment reaches a fully signed, notarized, autostart-registered, /Applications-installed status icon with no manual steps.

Recovery tag: `pre-phase1-m1.6-2026-05-07` (HEAD before this commit).

---

### Phase 1 / Tauri Doctor — M1.5 (code signing + Apple notarization)

Fifth execution session. The .app and .dmg now ship fully signed by Don's Developer ID Application certificate (`D8G67T74V6` team) and notarized by Apple's stapling service. Gatekeeper accepts both artifacts on a fresh Mac without "unverified developer" warnings.

**What signed.**

- **`Factotem Doctor.app`** — signed with the team-wide Developer ID Application cert + hardened runtime + the four standard Tauri-WebView entitlements (allow-jit, allow-unsigned-executable-memory, disable-library-validation, allow-dyld-environment-variables). Submitted to Apple notarization, ticket received, ticket stapled into the .app bundle. Output of `spctl --assess --type execute`: `accepted; source=Notarized Developer ID`.
- **`Factotem Doctor_0.1.0_aarch64.dmg`** — signed by the same cert, then submitted *separately* to notarization (Tauri's bundler signs the DMG but does not auto-notarize it; documented Tauri 2 quirk). Stapled. Output of `spctl --assess --type install`: `accepted; source=Notarized Developer ID`.

Both stapled artifacts pass Gatekeeper offline (the ticket lives inside the bundle/DMG). Online, the .app's ticket is sufficient for the operator's drag-to-/Applications path; the DMG's separate ticket helps when Bob's Mac Mini is offline at first install.

**Files changed.**

- **NEW `cli/claw-doctor/src-tauri/entitlements.plist`** — minimal hardened-runtime exception set for the WebView. Comment-free XML because Apple's AMFI plist parser inside `codesign` rejects DOCTYPE-internal comments (`AMFIUnserializeXML: syntax error near line 7` — encountered on the first build attempt; documented here so future contributors don't redo the diagnosis).
- **MODIFIED `cli/claw-doctor/src-tauri/tauri.conf.json`** — three keys flipped under `bundle.macOS`:
  - `signingIdentity: "Developer ID Application: Don Kruger (D8G67T74V6)"`
  - `entitlements: "entitlements.plist"`
  - `providerShortName: "D8G67T74V6"`
- **MODIFIED `~/.zshrc`** — operator-side, NOT committed. Adds:
  - `APPLE_SIGNING_IDENTITY` (Tauri reads on macOS)
  - `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` (used by `notarytool` and Tauri's auto-notarization in the bundler)
  - `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_APP_SPECIFIC_PASSWORD` (electron-builder aliases for the sister KanbanPro app — same secrets, both apps share the cert because Developer ID is team-wide)

**Why no App Store Connect entry.** The Doctor invokes `pkill`, `launchctl`, `docker`, and `bash -c` via subprocess; the App Store sandbox (`com.apple.security.app-sandbox`) blocks every one of those. Mac App Store distribution would require gutting the app. Developer ID + notarization is the right primitive for an operator tool that has to mutate launchd-managed state. Documented in entitlements.plist's preamble (the structural comment lives in CHANGE_LOG instead — see AMFI note above).

**Build run (verbatim, redacted).**

```
$ cargo tauri build
Signing with identity "Developer ID Application: Don Kruger (D8G67T74V6)"
Signing /Factotem Doctor.app/Contents/MacOS/factotem-doctor
Signing /Factotem Doctor.app
Notarizing /Factotem Doctor.app
Notarizing Finished with status Accepted for id 07bb908f-…
Stapling app...
Bundling Factotem Doctor_0.1.0_aarch64.dmg
Signing /Factotem Doctor_0.1.0_aarch64.dmg

$ xcrun notarytool submit Factotem\ Doctor_0.1.0_aarch64.dmg --wait …
status: Accepted (id 9dd5c271-…)

$ xcrun stapler staple Factotem\ Doctor_0.1.0_aarch64.dmg
The staple and validate action worked!
```

**Verification (post-build, live).**

- `codesign --display --verbose=2 "Factotem Doctor.app"` shows the full Apple Root → Developer ID Certification Authority → Developer ID Application: Don Kruger chain, `Notarization Ticket=stapled`, `flags=0x10000(runtime)`, TeamIdentifier `D8G67T74V6`.
- `codesign --verify --deep --strict` passes.
- `xcrun stapler validate` passes on both .app and .dmg.
- `spctl --assess` returns `accepted; source=Notarized Developer ID` on both.
- New PID 93796 alive after launch via `open Factotem Doctor.app`; tray icon installed and probe loop ticking.

**Sizes.** `.app` = 5.9 MB (was 5.8 MB unsigned — entitlements + signature add ~9 KB). `.dmg` = 3.9 MB. Slightly larger than M1.4 because the signing & notarization metadata adds bytes; still well under any practical distribution constraint.

**Convention check.** Pure additive — new file (`entitlements.plist`), three keys flipped in `tauri.conf.json`, plus this CHANGE_LOG entry. No orchestrator code touched. Reversal: revert the commit and the .app falls back to ad-hoc-signed (operator double-click on a fresh Mac shows the Gatekeeper warning, but the running install on Don's machine is unaffected). Operator-side `~/.zshrc` lines can be commented out with no impact on already-built artifacts; the cert lives in the login Keychain, not in any committed file.

**Distribution next.** With M1.5 done, the .dmg can be uploaded to a release page, hosted at a stable URL, or — per M1.6 — dropped into `/Applications` by `claw-setup` step 11 on every fresh install. M1.6 follows.

Recovery tag: `pre-phase1-m1.5-2026-05-07` (HEAD before this commit).

---

### Phase 1 / Tauri Doctor — M1.4 (Settings + Logs windows)

Fourth execution session. M1.3's Repair Stack landed earlier today and was operator-tested end-to-end (real `pkill` + Docker restart + step-4 verify polling). M1.4 adds the two remaining surfaces from the milestone plan: operator-configurable preferences and a live tail of `nanoclaw.log`.

**New plugins.**

- `tauri-plugin-autostart = "2"` — wraps macOS Login Items via a `LaunchAgent` plist at `~/Library/LaunchAgents/Factotem Doctor.plist`. The Settings toggle calls `manager.enable()` / `manager.disable()` on save.
- `tauri-plugin-notification = "2"` — fires a system notification on every state transition (green↔amber↔red) when `notify_on_state_change` is true. Title summarises the destination state ("Factotem stack offline"); body shows the state-label transition + the probe headline.

**New: `src-tauri/src/settings.rs` (operator preferences, atomic-write).** Five fields with sensible defaults (5s poll interval, launch-at-login on, notify-on-state-change on). Storage at `~/Library/Application Support/Factotem/doctor-settings.json` — same TCC-friendly tree the EPERM migration moved everything else into. Save uses write-temp-then-rename with mode 0o600 on the file and 0o700 on the parent. `load()` is graceful on missing/corrupt files (returns `Default`); `save()` returns a brief error string suitable for surfacing in the UI.

**New commands in `src-tauri/src/commands.rs`.**

- `get_settings()` / `save_settings(settings)` — read + write the in-memory settings cell wrapped in `Arc<Mutex<…>>`. Save also calls `sync_autostart()` so the Login Items state matches the toggle without a restart.
- `get_log_path()` / `tail_log(lines)` — resolve `nanoclaw.log` via `plutil -extract StandardOutPath raw -o -` against the launchd plist, with a fallback to `$HOME/Documents/NanoClaw/nanoclaw/logs/nanoclaw.log`. Tail uses `/usr/bin/tail -n N`; `lines` is clamped to [1, 5000] so the front-end can't request megabytes.

**Probe loop refactor (`lib.rs::run_probe_loop`).** Reads `poll_interval_ms` + notification toggles from the settings cell on every tick, so a Settings save takes effect on the very next probe (no restart). Tracks `prev_overall` and fires a notification only on transition (not every tick) — silent for green-to-green, audible for green-to-amber, etc. The `notify_audible` field is reserved but currently no-ops because Tauri 2's notification plugin doesn't expose a clean "silent" flag; operators wanting quiet notifications can use macOS Focus / Do Not Disturb in the meantime. Documented as a comment + a follow-up for M1.5.

**New menu items (`tray.rs`).**

- `Settings…` (Cmd+,) — opens the 480×560 Settings window with the form.
- `View NanoClaw logs…` (Cmd+Shift+L) — opens the 720×560 Logs window with the live tail.

Both items appear in the initial menu (visible at app launch before the first probe completes) and in the dynamic status menu (preserved across all states).

**New React views.**

- `src/views/SettingsView.tsx` — sectioned form (Probe / Startup / Notifications) with a number input for poll-interval-seconds (1–60) and three toggles. Save button is disabled while `busy`; surfaces save success/failure inline. Hint text under each control explains what changes when.
- `src/views/LogsView.tsx` — terminal-styled tail viewer. Toolbar exposes line-count selector (100/250/500/1000), Refresh, Live toggle (auto-refresh every 3s), and Copy-to-clipboard. Auto-follows the tail unless the operator scrolls up; resumes follow when scrolled back to the bottom (16 px threshold). Uses `#0d1117` background + `#c9d1d9` foreground for a readable monospace pane.

**Capability changes (`capabilities/default.json`).** Added `notification:default` and `autostart:default` permissions. Window list (`main`, `repair`, `diagnostics`, `logs`, `settings`) was already future-proofed during M1.3.

**Build artefacts.** `cargo tauri build` produces 5.8 MB `Factotem Doctor.app` + 5.6 MB DMG. New binary launched live (PID 4773) and the autostart plugin auto-registered the LaunchAgent at `~/Library/LaunchAgents/Factotem Doctor.plist`.

**Convention check.** Pure additive — new files in `cli/claw-doctor/`, modifications to `cli/claw-doctor/`, plus this CHANGE_LOG entry. No orchestrator code touched. Reversal: `git revert <commit>` plus `launchctl unload ~/Library/LaunchAgents/Factotem\ Doctor.plist && rm ~/Library/LaunchAgents/Factotem\ Doctor.plist` to undo the autostart side effect. Zero risk to NanoClaw production.

Files changed:

```
NEW   cli/claw-doctor/src/views/SettingsView.tsx        ~310 lines
NEW   cli/claw-doctor/src/views/LogsView.tsx            ~290 lines
M     cli/claw-doctor/src/main.tsx                      (+ settings/logs routes)
M     cli/claw-doctor/src/lib/tauri.ts                  (+ Settings type + 4 commands)
M     cli/claw-doctor/src-tauri/Cargo.toml              (+ autostart + notification plugins)
M     cli/claw-doctor/src-tauri/src/settings.rs         (placeholder → full load/save)
M     cli/claw-doctor/src-tauri/src/commands.rs         (+ 4 commands + autostart sync helper)
M     cli/claw-doctor/src-tauri/src/lib.rs              (+ plugins, settings cell, dynamic poll, notification firing)
M     cli/claw-doctor/src-tauri/src/tray.rs             (+ OPEN_SETTINGS + OPEN_LOGS menu items)
M     cli/claw-doctor/src-tauri/capabilities/default.json (+ notification + autostart perms)
M     docs/CHANGE_LOG.md                                (this entry)
```

**Visual verification waiting on Don.**

- Click Doctor in menu bar → menu now has Settings… and View NanoClaw logs… items
- Click Settings… → window opens with current values populated; toggle launch-at-login off, click Save, verify `~/Library/LaunchAgents/Factotem Doctor.plist` removed; toggle back on, verify it returns
- Click View NanoClaw logs… → window opens with the most recent 250 lines of `logs/nanoclaw.log`; new lines appear in ≤3s while Live is on
- Trigger a state change (`launchctl bootout gui/$(id -u)/com.nanoclaw`) → notification fires within one probe interval
- Bring NanoClaw back up → notification fires again with the recovered title

Recovery tag: `pre-phase1-m1.4-2026-05-07` (HEAD before this commit).

M1.5 (code signing via Don's Apple Dev ID) and M1.6 (claw-setup wizard step 11 deploys the .app to /Applications) follow.

---

### EPERM durable migration — `dashboard/out` + `data/ipc` symlinked out of `~/Documents/`

Resolves the recurring TCC-EPERM failure class first observed earlier today (2026-05-07 morning) when `brew reinstall node` invalidated the launchd-spawned NanoClaw's TCC grant for `~/Documents/`. The migration is symlink-only (zero code changes); commits as documentation + recovery tag for future reference.

**Migration steps (executed live):**

1. `bootout` NanoClaw + stop running containers
2. `mkdir -p ~/Library/Application\ Support/Factotem/{dashboard-out,ipc}` (the recovery.html from Phase 0 already lives in this dir)
3. `cp -R` content from `nanoclaw/dashboard/out/.` and `nanoclaw/data/ipc/.` to the new locations
4. `mv` originals to `dashboard/out.pre-eperm.bak` and `data/ipc.pre-eperm.bak`
5. `ln -s` symlinks at the original paths pointing at the new locations
6. `bootstrap` NanoClaw

**Why symlinks are sufficient.** macOS TCC checks happen at kernel `open()` / `scandir()` time on the resolved path, not the path-string passed to the syscall. So `fs.readFileSync('nanoclaw/dashboard/out/index.html')` resolves through the symlink to `~/Library/Application Support/Factotem/dashboard-out/index.html` before the TCC check fires. `~/Library/Application Support/` is TCC-unrestricted, so the open succeeds even when the grant for `~/Documents/` has been revoked.

**Verified live (PID 36718, post-migration).**
- Zero new EPERM hits in `logs/nanoclaw.error.log` since the restart
- All 7 dashboard routes return 200 (`/`, `/health`, `/activity/`, `/groups/`, `/cost/`, `/alerts/`, `/audit/`)
- IPC watcher logged "IPC watcher started (per-group namespaces)" cleanly
- Symlinked path resolves correctly: `ls -la nanoclaw/data/ipc/whatsapp_main/` shows `available_groups.json` (160 KB) at the resolved location
- `/api/groups` returns 9 groups (orchestrator reading SQLite cleanly)
- WhatsApp connection re-established after the restart

**Other `~/Documents/`-rooted paths NOT migrated.** `groups/{name}/CLAUDE.md`, `store/messages.db`, `store/auth/`, `logs/`, `data/sessions/` continue to work because they're held open via persistent file descriptors (SQLite mmap, Baileys append-only auth files, log fds). If TCC starts blocking those too, the same symlink pattern extends.

**Files changed.** This commit only updates docs:
- `docs/OPERATIONS.md` § "EPERM under launchd context — TCC token refresh remedy" — "Durable fix (deferred)" section replaced with "Durable fix (shipped 2026-05-07)" describing the symlink layout, why it works, and what remains optional
- `docs/CHANGE_LOG.md` — this entry

The actual filesystem mutations (mkdir, cp, mv, ln -s) are operator-side state, not committed code.

**Convention check.** No code touched. The symlinks at `nanoclaw/dashboard/out` and `nanoclaw/data/ipc` are gitignored (the `out/` and `ipc/` paths were already gitignored as build artefacts / runtime state). The `.pre-eperm.bak` backup directories are also gitignored implicitly (the patterns cover them). Reversal: `rm` the symlinks, `mv` the `.bak` directories back. Zero risk to NanoClaw's source-code surface.

Recovery tag: `pre-eperm-migration-2026-05-07` (HEAD before this commit). Apply via `git checkout pre-eperm-migration-2026-05-07` and reverse the filesystem move; no code revert needed.

---

### Phase 1 / Tauri Doctor — M1.3 (Repair Stack window + sequential executor)

Second execution session. M1.2 was visually verified by Don this morning (multi-instance amber state correctly displayed `2 NanoClaw services loaded` with both labels and the "only one is bound to :7842" framing). M1.3 wires the highest-leverage menu item — `Repair Stack…` — to a real Tauri window backed by a sequential shell-command executor.

**New: `src-tauri/src/repair.rs`.** The executor reads the bundled `recovery-steps.json`, runs each step's `command` via `bash -c`, and (for steps with a `verify` block) polls a verification command until success or `max_wait_ms` elapses. Required steps abort the chain on failure; non-required steps are marked Skipped. Per-step state transitions are streamed to the frontend over the `repair-progress` Tauri event channel; the synchronous return value is the authoritative final result.

The Docker step's `verify` block (`docker info`, polled every 2s up to 60s) is the canonical example — `open -a Docker` returns instantly but the daemon takes 15-30s to be reachable; the verify-with-polling pattern handles this without arbitrary sleeps.

**New: typed-confirm gate.** Operator must type `RESTART STACK` literally before the Run Repair button enables. Both client-side (button disabled state) and server-side (`start_repair(confirm)` checks the phrase before invoking the executor) — defence in depth, mirrors the existing `RestartStackButton` pattern in the dashboard.

**Window management.** New `open_or_focus_window()` helper in `commands.rs` builds windows on demand via `WebviewWindowBuilder`. Repair Stack opens at 480×720 with min size 420×520; "Show diagnostic details" opens its own 560×720 window pointing at the same `index.html` with a different `?view=` query param. React routes on the query param; multi-window architecture is in place even though only the Repair window has full UI in this milestone.

**New React surface (`src/views/RepairView.tsx`).** Self-contained — own component-scoped CSS-in-JS, mirrors the dashboard's design tokens (orange accent, hairline-bordered cards, rounded-2xl radii, Comfortaa typography). Renders:

- Header with Factotem branding + lede explaining "this just wraps OPERATIONS.md commands so you don't have to copy-paste"
- Confirm bar with the typed-confirm input (auto-uppercases input as the operator types) + the Run Repair button
- Step list — one card per step with status badge (Pending / Running / Done / Failed / Skipped) flipping live as events arrive, the why text, the actual command, and a collapsible detail block on Failed/Skipped showing stderr
- Footer state: SuccessFooter on completion (with total duration) or FailureFooter pinpointing which step blew up (with detail and re-run guidance)

**New: `src-tauri/capabilities/default.json`.** Tauri 2 requires explicit capability grants for plugin permissions on WebView windows. The capability covers `core:default`, `core:event:default` (for the `repair-progress` listener), `core:window:default`, `shell:default`, `opener:default`. Listed for windows `main`, `repair`, `diagnostics`, `logs`, `settings` — forward-compatible with M1.4 windows.

**Polish bundled in (the M1.2 freebie).** `truncate_for_menu()` in `tray.rs` bumped from 80 → 130 chars. Don's M1.2 screenshot showed the multi-instance detail truncating mid-port-number at `:78…`; 130 fits the full message ("…Only one is bound to :7842; the others may be stale installs.") with margin.

**Reused primitives.**
- `recovery-steps.json` from M1.1 — single source of truth for the step content
- `RepairEvent` shape mirrors the orchestrator's existing audit-log + alerts conventions (tagged-union, snake_case discriminant, `type` field)
- React design tokens copied verbatim from the dashboard's `tokens.css` (with dark-mode + light-mode media queries)
- `bash -c` for shell command exec — handles the `&&`, `$()` composition in `cd ~/.onecli && docker compose up -d` and `launchctl kickstart -k gui/$(id -u)/com.nanoclaw`

**Convention check.** Pure additive — new Rust module `repair.rs`, new React view, new capability config, new menu item. No orchestrator code touched. No mutations to the running NanoClaw deployment until the operator explicitly types the confirmation phrase. Reversal: remove `cli/claw-doctor/src-tauri/src/repair.rs` + revert `tray.rs`/`commands.rs`/`lib.rs` additions. Zero risk.

**What ships in subsequent sessions per the design doc.**
- M1.4 — Settings (poll cadence, launch-at-login, notifications) + Logs window (`nanoclaw.log` tail) (~0.5 day)
- M1.5 — Code signing via Don's Apple Dev ID (~0.5 day)
- M1.6 — `claw-setup` step 11 drops the `.app` into `/Applications` (~0.5 day)

The "EPERM durable migration" (move `dashboard/out/` and `data/ipc/` out of `~/Documents/`) remains an outstanding parallel track per the OPERATIONS.md note added on 2026-05-07.

Recovery tag: `pre-phase1-m1.3-2026-05-07` (HEAD before this commit).

---

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
