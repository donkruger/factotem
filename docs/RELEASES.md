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
| `latest.json` | Tauri updater manifest. The Doctor polls this URL: `https://github.com/donkruger/factotem/releases/latest/download/latest.json` |

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
| v0.1.1 (R.1 build, plugin but no UI) | Any later version | Manual: as above. The next install bridges to v0.1.2 which has the auto-update UI. |
| v0.1.2 or later | Any newer release | Auto: notification + Settings banner + click Install. |

The first version with full auto-update support is **v0.1.2**.

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

## How a release is tagged + built (maintainers)

The release pipeline is in `.github/workflows/release.yml` on the **source repo** (`donkruger/factotem`). It builds in the source repo, then pushes the release assets to the **public mirror** (`RichardBNel/Factotem`) using a `MIRROR_REPO_TOKEN` secret with `repo` scope on the mirror.

To ship a release:

1. **Bump version** in four places:
   - `cli/claw-doctor/package.json` `version`
   - `cli/claw-doctor/package-lock.json` (re-run `npm install --package-lock-only`)
   - `cli/claw-doctor/src-tauri/Cargo.toml` `[package].version`
   - `cli/claw-doctor/src-tauri/Cargo.lock` (re-run `cargo check` to refresh)
   - `cli/claw-doctor/src-tauri/tauri.conf.json` `version`

2. **Add a CHANGE_LOG entry** at the top of `docs/CHANGE_LOG.md`. The workflow extracts the latest entry as the GitHub release's notes.

3. **Commit + push** to `main`.

4. **Tag + push the tag**:
   ```bash
   git tag vX.Y.Z HEAD
   git push origin vX.Y.Z
   ```

5. **Watch the workflow**:
   ```bash
   gh run watch --exit-status
   ```
   Takes ~10–15 minutes (Tauri build + Apple notarisation queue).

6. **Verify the release** (assets land on the public mirror repo, not the source):
   ```bash
   gh release view vX.Y.Z --repo RichardBNel/Factotem
   curl -sI https://github.com/RichardBNel/Factotem/releases/latest/download/latest.json
   ```

### If a release is broken

```bash
# Cancel the workflow if still running
gh run cancel <run-id> --repo donkruger/factotem

# Delete the release on the public mirror + tag on the source
gh release delete vX.Y.Z --repo RichardBNel/Factotem --yes
git tag -d vX.Y.Z
git push origin :vX.Y.Z

# Fix + re-tag
```

Operators who already auto-installed the broken version can downgrade per the section above. **Mark broken releases as pre-release in the GitHub UI** so the updater stops offering them as the "latest" — Tauri respects the `--latest` flag.

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
