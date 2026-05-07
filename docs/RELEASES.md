# Releases

This document explains how Factotem Doctor releases work — for operators downloading + updating, and for maintainers tagging + publishing.

## Where to download

Releases are published to the **public mirror repo**: **[github.com/RichardBNel/Factotem/releases/latest](https://github.com/RichardBNel/Factotem/releases/latest)**

The source repo (`donkruger/factotem`) is private. CI builds + signs + notarises in the source repo, then pushes the release artefacts to `RichardBNel/Factotem` (public) so the Tauri updater plugin can poll `https://github.com/RichardBNel/Factotem/releases/latest/download/latest.json` without authentication. Operators only ever see + interact with the public mirror.

Each release ships four files:

| File | Purpose |
|---|---|
| `Factotem-Doctor_X.Y.Z_aarch64.dmg` | Drag-installable disk image. Apple Silicon only (arm64). Signed by Don's Developer ID + notarised by Apple. |
| `Factotem-Doctor_X.Y.Z_aarch64.app.tar.gz` | Same .app, packed for the in-app updater. Operators don't download this directly — the running Doctor consumes it during auto-update. |
| `Factotem-Doctor_X.Y.Z_aarch64.app.tar.gz.sig` | Ed25519 signature of the .tar.gz. The Doctor verifies this against its embedded public key before installing. |
| `latest.json` | Tauri updater manifest. The Doctor polls this URL: `https://github.com/RichardBNel/Factotem/releases/latest/download/latest.json` |

For a fresh install, you only need the `.dmg`.

## How auto-updates work

The Doctor (v0.1.2 and later) polls `latest.json` every 4 hours when running. When a newer version is found:

1. A system notification fires: **"Factotem Doctor vX.Y.Z available."**
2. The Settings window's "Updates" section shows a banner with release notes + an **Install + restart now** button.
3. Clicking Install:
   - Downloads `Factotem-Doctor_X.Y.Z_aarch64.app.tar.gz` to a temp directory.
   - Verifies the ed25519 signature against the bundled public key. **If the signature is invalid, the install is aborted.**
   - Replaces `/Applications/Factotem Doctor.app` with the new bundle.
   - Calls `app.restart()` — the running process exits, macOS re-launches the new binary.
   - Whole flow takes ~15 seconds on a normal connection.

You can dismiss the banner with **Later** — the Doctor keeps running at the current version. The banner reappears on the next launch (or the next poll if Settings is open).

### Disabling auto-checks

Open **Doctor → Settings… → Updates** and toggle off **"Check for updates automatically."**

The Doctor will not poll, but the **Check now** button still works for manual checks.

### Manual checks

In the Settings window, click **Check now** to force an immediate poll. Useful when you've heard about a release or you've just woken the machine.

## How to upgrade an existing install

| From | To | Path |
|---|---|---|
| v0.1.0 (M1.6 build, no updater plugin) | Any later version | Manual: download the .dmg from the GitHub release page, drag to /Applications. |
| v0.1.1 (R.1 + R.2 build, plugin but no UI) | Any later version | Manual: as above. The next install bridges to v0.1.2 (auto-update UI) or v0.1.3+ (public-mirror endpoint). |
| v0.1.2 (R.3 + R.4 build, UI but private endpoint) | v0.1.3 or later | Manual: the v0.1.2 build still polls the old `donkruger/factotem` URL which returns 404. Install v0.1.3+ from the public mirror once. |
| **v0.1.3 or later** | Any newer release | **Auto:** notification + Settings banner + click Install. |

The first version with end-to-end auto-update against the public mirror is **v0.1.3**. v0.1.0 → v0.1.3 needs one manual install; from v0.1.3 onwards the operator never has to touch the .dmg again.

## How to manually downgrade

Sometimes a release is broken and you need to step back. Auto-update has no "downgrade" path by design — Tauri's updater only installs newer versions.

Two ways to downgrade:

1. **Via the standalone installer** (if the older .app bundle is still in your repo's `cli/claw-doctor/src-tauri/target/release/bundle/macos/`):
   ```bash
   bash scripts/install-doctor.sh
   ```
   This uses `ditto` to overwrite `/Applications/Factotem Doctor.app` with the source bundle. The auto-updater on next launch will detect that you're "behind" and prompt to upgrade — disable auto-update temporarily if you want to stay on the older version.

2. **Manually**, from a GitHub release:
   ```bash
   pkill -9 -f factotem-doctor
   cd /tmp && \
   curl -LO "https://github.com/RichardBNel/Factotem/releases/download/vX.Y.Z/Factotem-Doctor_X.Y.Z_aarch64.dmg"
   open Factotem-Doctor_X.Y.Z_aarch64.dmg
   # Drag the .app from the mounted DMG to /Applications, replacing the existing.
   ```

## Release conventions

These are the rules every release must follow. They're enforced partly by CI (the workflow trigger, the version-bump checks), partly by convention (cadence, semver). Maintainers cutting a release should treat this as a checklist.

### Versioning (semver, pre-1.0)

While the Doctor is in **0.x.x** we follow:

| Bump | When |
|---|---|
| **Patch** (0.1.X) | Bug fixes, doc updates, internal refactors, single-milestone shipments (R.5, R.6, etc.). Default. |
| **Minor** (0.X.0) | New phase milestone group, new operator-visible feature surface, schema additions, breaking API additions to /api/* endpoints. |
| **Major** (X.0.0) | Reserved for first stable release (1.0.0) — not used during 0.x.x. |

When 1.0.0 is cut (TBD, likely after Phase 3 — multi-tenant), patch and minor follow standard semver semantics: patch = backward-compat fix, minor = backward-compat feature, major = breaking change.

### Tag namespace

Tags fall into **two distinct namespaces** that must not collide:

| Namespace | Format | Triggers CI? | Pushed to | Purpose |
|---|---|---|---|---|
| **Release tags** | `vX.Y.Z` (e.g. `v0.1.3`) | ✓ Yes — `.github/workflows/release.yml` triggers on `'v*'` | Source repo (`donkruger/factotem`); CI then publishes the artefacts to the public mirror under the same tag name | Permanent, shipping moments. |
| **Recovery tags** | `pre-<milestone>-YYYY-MM-DD` / `post-<milestone>-YYYY-MM-DD` (e.g. `pre-r5-2026-05-07`, `post-phase1-m1.5-2026-05-07`) | ✗ No | Source repo only | Per-commit checkpoints around milestones for clean reverts. |

**Never tag a non-release commit with `vX.Y.Z`** — it would trigger CI uselessly. **Never tag a release commit only with a recovery tag** — operators expect `vX.Y.Z` to be the canonical version marker.

### Cadence

**One release per closed milestone group.** The current pattern (Phase 2):

| Milestone(s) | Version |
|---|---|
| R.1 (no operator-visible change) | No release |
| R.2 (workflow + first signed release) | v0.1.1 |
| R.3 + R.4 (operator UI + docs — shipped together) | v0.1.2 |
| R.5 (public mirror cutover) | v0.1.3 |

Group sub-milestones that ship in the same commit (R.3 + R.4 above) into a single release. Don't ship a release for milestones that don't change runtime behaviour (R.1 was internal-only).

### Version bump checklist

Every release commit must update **five files** to the new version. The CI workflow doesn't enforce this, but mismatch is an error:

| File | Field | Refresh command |
|---|---|---|
| `cli/claw-doctor/package.json` | `"version"` | edit by hand |
| `cli/claw-doctor/package-lock.json` | top-level `"version"` + nested `packages."".version` | `cd cli/claw-doctor && npm install --package-lock-only` |
| `cli/claw-doctor/src-tauri/Cargo.toml` | `[package].version` | edit by hand |
| `cli/claw-doctor/src-tauri/Cargo.lock` | `factotem-doctor` `version` | `cd cli/claw-doctor/src-tauri && cargo check` |
| `cli/claw-doctor/src-tauri/tauri.conf.json` | `"version"` | edit by hand |

The `cargo check` + `npm install` regenerate the lockfile entries automatically.

### CHANGE_LOG format

Every release commit must include a new entry at the **top** of `docs/CHANGE_LOG.md`. The release workflow auto-extracts this entry as the GitHub Release notes, so its quality matters:

```markdown
## YYYY-MM-DD                         ← release date heading

### Phase N / <milestone description> → vX.Y.Z

<one-paragraph summary of what changed and why>

**Files changed.** <bullet list>

**Convention check.** <pure additive / extends / replaces; reversal path>

**Recovery tag:** `pre-<milestone>-YYYY-MM-DD`.

---

### <previous entry>
```

The workflow extracts everything from the **first** `## YYYY-MM-DD` heading until the **second** `## YYYY-MM-DD` heading using `awk`. So a single date block can hold multiple `### …` sub-entries — they all become part of the release notes.

### Asset naming

The workflow stages artefacts with **URL-safe names** (hyphens, no spaces) before uploading. Always:

```
Factotem-Doctor_X.Y.Z_<arch>.dmg
Factotem-Doctor_X.Y.Z_<arch>.app.tar.gz
Factotem-Doctor_X.Y.Z_<arch>.app.tar.gz.sig
latest.json                                   # singular — overwritten per release
```

Currently `<arch>` is `aarch64` only (Apple Silicon). When the build matrix expands to Intel, add `x86_64` artefacts; add a `darwin-x86_64` entry to `latest.json`'s `platforms` block alongside `darwin-aarch64`.

### Pre-release flagging

A release is `--latest` (Tauri updater target) **unless** it's:

- A **broken release** that's already been auto-installed by some operators — see "If a release is broken" below.
- A **release candidate** (e.g. `v0.2.0-rc1`) — not yet used; reserved for when stable channel + beta channel split.

Pre-release flag is set via the GitHub UI (Releases → Edit → "Set as a pre-release") or `gh release edit vX.Y.Z --prerelease`. Tauri's updater respects the `--latest` flag and ignores pre-releases by default.

### Branch + tag origin

- Release tags are cut from **`main`** only.
- `main` and `staging` are kept in sync (every commit is pushed to both — `git push origin main && git push origin main:staging`).
- Tags themselves only need to live on `main` — the workflow doesn't care which branch the tag points at as long as the commit it references contains the right code.

### Cross-repo write secret rotation

The `MIRROR_REPO_TOKEN` GitHub Actions secret on `donkruger/factotem` must always have:
- `repo` scope (classic PAT) **or** equivalent fine-grained `Contents: Read and write` on `RichardBNel/Factotem`
- A non-expired token

If the token expires or is rotated:
1. Generate a fresh token on `account.github.com` with the right scope.
2. `gh secret set MIRROR_REPO_TOKEN --repo donkruger/factotem` to replace.
3. No commit needed — secrets are out-of-band.

The current token is sourced from Don's classic PAT (visible via `gh auth token`). Future hardening: switch to a fine-grained PAT scoped only to `RichardBNel/Factotem` (limits blast radius if the token leaks).

---

## How a release is tagged + built (maintainers)

The release pipeline is in `.github/workflows/release.yml` on the **source repo** (`donkruger/factotem`). It builds in the source repo, then pushes the release assets to the **public mirror** (`RichardBNel/Factotem`) using a `MIRROR_REPO_TOKEN` secret with `repo` scope on the mirror.

To ship a release (follow the conventions above):

1. **Bump version** per the [Version bump checklist](#version-bump-checklist) above. Five locations.

2. **Add a CHANGE_LOG entry** at the top of `docs/CHANGE_LOG.md`, following the [CHANGE_LOG format](#change_log-format). The workflow extracts everything from the latest `## YYYY-MM-DD` heading as the GitHub release's notes.

3. **Commit + push** to `main` and `staging`:
   ```bash
   git add <files> docs/CHANGE_LOG.md
   git commit -m "feat(release): ... vX.Y.Z"
   git push origin main && git push origin main:staging
   ```

4. **Tag + push the tag**:
   ```bash
   git tag vX.Y.Z HEAD
   git push origin vX.Y.Z
   ```

5. **Watch the workflow** (~10–15 min — Tauri build + Apple notarisation + DMG re-notarisation):
   ```bash
   gh run watch --exit-status
   ```

6. **Verify the release** lands on the **public mirror**:
   ```bash
   gh release view vX.Y.Z --repo RichardBNel/Factotem
   curl -sI https://github.com/RichardBNel/Factotem/releases/latest/download/latest.json
   ```
   The HTTP status must be `200` and the manifest must contain a `signature` and the public download URL pointing at `RichardBNel/Factotem`.

7. **Stamp the post-tag** (recovery namespace, NOT a release tag):
   ```bash
   git tag post-<milestone>-YYYY-MM-DD HEAD
   git push origin post-<milestone>-YYYY-MM-DD
   ```

### If a release is broken

A "broken release" is one that:
- Crashes on launch on a clean install
- Auto-installs but the new binary panics or won't probe
- Has an invalid signature (no operator can install)
- Contains a regression that's worse than the prior release

When you discover one:

```bash
# 1. Stop the bleeding — flag the release as pre-release on the public mirror
#    so the Tauri updater stops offering it as "latest".
gh release edit vX.Y.Z --repo RichardBNel/Factotem --prerelease

# 2. Delete the release entirely IF no operator has auto-installed yet
#    (otherwise downgrade is harder — see below).
gh release delete vX.Y.Z --repo RichardBNel/Factotem --yes
git tag -d vX.Y.Z
git push origin :vX.Y.Z   # delete tag on source repo

# 3. Fix forward: cut a new release vX.Y.(Z+1) per the normal flow.
#    The auto-updater offers operators the new patch on next poll.
```

If a broken release **has already been auto-installed** by some operators, the simplest path is **fix forward** (cut vX.Y.(Z+1) immediately). Operators downgrade manually per "How to manually downgrade" if they prefer that route.

**Always cancel an in-flight workflow** if you spot the bug while CI is still running:
```bash
gh run cancel <run-id> --repo donkruger/factotem
```

## Trust model

Two cryptographic primitives, separate threat models:

| Layer | Key | Verifies | Threat |
|---|---|---|---|
| **Apple Developer ID + notarisation** | Don's `D8G67T74V6` cert + Apple's notary service | The .dmg + .app are from a known developer + scanned by Apple | Gatekeeper / OS-level trust on first launch |
| **Tauri updater (ed25519)** | Keypair generated in R.1, public key embedded in the Doctor | The `.app.tar.gz` payload during in-app update | Update integrity — protects against MITM or compromised release artefacts |

Both must pass before an update lands. Lose either key and:
- **Apple cert lost** → can't ship NEW notarised binaries until the cert is renewed; existing installs keep working.
- **Tauri updater key lost** → can't sign new updater payloads; auto-update breaks for everyone until a new pubkey is shipped (which itself requires a manually-distributed bridge release).

The Tauri private key lives at `~/Library/Mobile Documents/com~apple~CloudDocs/Keychain Certificates/Factotem/factotem-doctor-updater.key` on Don's machine + as a GitHub Actions secret.

## Why two repos?

The source repo (`donkruger/factotem`) is private to keep the orchestrator + dashboard + integration code out of public view (Brain integration patterns, KP cross-link details, customer-data-adjacent logic). But the Tauri updater plugin polls a public URL — it can't authenticate. Two-repo split solves it:

| Repo | Visibility | Purpose |
|---|---|---|
| `donkruger/factotem` | Private | Source of truth. CI runs here. Holds CHANGE_LOG, plans, all integration code. |
| `RichardBNel/Factotem` | Public | Mirror that holds release artefacts only — `.dmg`, `.app.tar.gz`, `.app.tar.gz.sig`, `latest.json`. The updater plugin polls this repo's `latest.json`. |

The mirror repo's commit history isn't synced; only the **release page** is. From a fresh clone of `RichardBNel/Factotem` an outsider can download the Doctor but can't see the orchestrator code.

## What's NOT auto-updated

| Component | Update path |
|---|---|
| **NanoClaw orchestrator** (`src/`, the dashboard, etc.) | `git pull` + `npm run build` + `launchctl kickstart` — operators customise these by editing the code, so auto-update would silently overwrite local changes. |
| **claw-setup wizard** | Same — shipped with the repo, operators run `git pull` to upgrade. |
| **Per-group containers** | `./container/build.sh` after orchestrator changes; the agent-runner cache sync per `CLAUDE.md`. |

Auto-updates apply only to the Doctor menu-bar app — it's a binary distributed as a notarised artefact, with no operator-level customisation expected.
