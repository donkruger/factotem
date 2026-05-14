# @nanoclaw/claw-setup-gui

Electron-based desktop setup wizard for NanoClaw.

This package is the GUI sibling of [`@nanoclaw/claw-setup`](../claw-setup/).
It applies the Factotem dashboard's design language (Apple-flat, warm
orange `#ff7a3a` accent, Comfortaa wordmark) to NanoClaw's setup journey
and hands off to the dashboard at `http://localhost:3001` when setup
completes.

> Status: **complete end-to-end journey with dashboard handoff and release pipeline.**
> All 12 CLI steps mapped to GUI screens. Five run their work directly (Welcome,
> Profile, EnvCheck, Install, OneCLI, Mounts, Container, Service, Smoke,
> Ready); three honest-handoff to the CLI for steps that require deeper
> orchestrator refactors (WhatsApp QR pairing, main-group registration via
> SQLite, open-DM mode SQL update). See [`docs/ui-ux-direction.md`](../../docs/ui-ux-direction.md)
> for the three-surface architecture, [`CLAUDE.md`](CLAUDE.md) for agent
> rules, and [`UI-MIGRATION-FEASIBILITY.md`](../../../UI-MIGRATION-FEASIBILITY.md)
> for the full migration plan.

## How it relates to `claw-setup` and the dashboard

Three surfaces share the design language and state:

- **CLI wizard** (`cli/claw-setup/`) — headless / SRE install path
- **GUI wizard** (this package) — download-and-double-click installer
- **Dashboard** (`dashboard/`) — post-setup daily-use home

Both wizards read/write `~/.config/nanoclaw/setup-state.json`. The GUI
probes `/health` on launch — if everything's up, it opens the dashboard
in the user's default browser and quits without showing a window. If
not, it resumes the wizard at the saved step.

The CLI remains the canonical headless path. It is **not deprecated**.

## Quickstart

```bash
cd nanoclaw/cli/claw-setup-gui
npm install
npm run build        # builds main + preload + renderer into ./out/
npm run dev          # electron-vite dev server
```

The first `npm run build` is important — `out/preload/index.js` needs
to exist on disk before `npm run dev` starts, otherwise the renderer
loads before preload attaches and you get a `Cannot read properties of
undefined (reading 'app')` error. The `useElectronAPI` hook guards
against the transient case but it's nicer to avoid the race entirely.

In dev mode, the wizard auto-skips to the dashboard if `/health` is
reachable AND the dashboard URL resolves — same logic as the
production build. Set `NANOCLAW_FORCE_WIZARD=1` to bypass when
iterating on wizard UI.

## Build a release

Local-only DMG (unsigned, for testing):

```bash
npm run build:mac-local       # → ./dist/nanoclaw-setup.dmg
```

Full release (signed, notarised, published to the public mirror):

```bash
npm run release               # patch bump (0.1.0 → 0.1.1)
npm run release -- minor      # 0.1.0 → 0.2.0
npm run release -- major      # 0.1.0 → 1.0.0
```

The script bumps the version, tags as `wizard-vN.N.N`, and pushes the
tag. The push triggers `.github/workflows/release-wizard.yml` which
builds + signs + notarises the DMG on a `macos-14` runner and creates
the GitHub release on the **public mirror** `RichardBNel/Factotem`
via the `MIRROR_REPO_TOKEN` PAT (same two-repo pattern the Doctor
pipeline already uses).

After the first release, the stable always-latest URL is:

- `https://github.com/RichardBNel/Factotem/releases/latest/download/nanoclaw-setup.dmg`

### Required GitHub Actions secrets

All of these are already configured on the source repo for the Doctor
pipeline — the wizard pipeline **reuses them by name**, so there's
nothing new to add if the Doctor releases successfully:

| Secret | Used for |
|---|---|
| `APPLE_CERT_BASE64` | `base64 -i cert.p12` of the Developer ID .p12 |
| `APPLE_CERT_PASSWORD` | passphrase for the .p12 |
| `APPLE_ID` | Apple ID for notarytool |
| `APPLE_PASSWORD` | app-specific password (appleid.apple.com → App-Specific Passwords) |
| `APPLE_TEAM_ID` | Apple Developer team ID (e.g. `D8G67T74V6`) |
| `MIRROR_REPO_TOKEN` | PAT with `repo` scope on `RichardBNel/Factotem` |

The workflow re-exports these under the env-var names electron-builder
expects internally (`CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_APP_SPECIFIC_PASSWORD`),
so the Doctor's secret names stay canonical across both pipelines.

### Windows builds

Not in v1. The DMG is the only artefact the workflow currently produces.
EasyClaw's NSIS recipe is still in `electron-builder.yml` for when the
Windows port is needed — uncomment the build-win job and add the
respective Windows code-signing secrets when that time comes.

## What works today

| Step | CLI id | GUI implementation |
|---|---|---|
| Welcome | — | Themed mascot + wordmark + CTA |
| Profile | 00 | Profile picker, assistant name, writes state + .env |
| EnvCheck | 01 | Probes Node ≥20, Docker, Tailscale, OneCLI |
| Install | 02 | Re-probe + manual "Mark installed" confirm |
| OneCLI | 03 | Two-substep form (auth + register Anthropic secret) |
| Mounts | 04 | Directory picker + allowlist writer (`mount-allowlist.json`) |
| Container | 05 | Runs `container/build.sh` with live LogViewer streaming |
| WhatsApp | 06 | CLI handoff (QR-in-terminal — architectural blocker) |
| Service | 09 | macOS launchd plist write + `launchctl bootstrap` |
| Register group | 07 | CLI handoff (SQLite read; avoids bundling native module) |
| Open-DM | 08 | Form + CLI handoff (SQLite UPDATE) |
| Smoke test | 10 | `/health` poll loop, profile-aware confirm |
| Ready | 11 | Waits for `/health`, opens dashboard, quits |

| Infrastructure | Status |
|---|---|
| State file shared with `claw-setup` CLI | ✅ |
| Light-mode visual system aligned to dashboard tokens | ✅ |
| Skip-when-healthy boot logic | ✅ |
| `useElectronAPI()` readiness hook (preload race guard) | ✅ |
| `electron-builder` DMG (drag-to-Applications) | ✅ |
| GitHub Actions release pipeline | ✅ |
| App icon (`icon.icns` / `icon.ico` / `icon.png`) | ✅ v0.1 placeholder |
| DMG background (`background.png` / `@2x`) | ✅ v0.1 placeholder |
| Asset regeneration script (`npm run build:assets`) | ✅ |
| Code-signing certificates (`CSC_LINK` + Apple secrets) | ⚠️ must be added to repo |

## CLI handoffs — and why

Three steps surface a CLI command instead of running the work in-process:

- **WhatsApp pair (step 06)** — `whatsapp-auth.ts` renders the QR via
  `qrcode-terminal` directly to stdio. Porting needs a refactor to
  emit the QR payload over IPC. Queued in `claw-setup-gui/CLAUDE.md`
  § Future work.
- **Register main group (step 07)** — needs to read recent WhatsApp
  groups from the orchestrator's SQLite messages.db. Bundling
  better-sqlite3 means rebuilding a native module per Electron /
  per platform — not worth the complexity for a step the operator
  runs once.
- **Open-DM mode SQL update (step 08)** — same SQLite concern. The
  GUI collects the preference and shows the command to apply it.

The remaining nine steps run their work end-to-end in the GUI.

## Architecture (one paragraph)

`src/main/` is the Node.js side — runs in a privileged process,
talks to the filesystem, spawns commands, probes `/health`. `src/preload/`
is the bridge — exposes `window.electronAPI` to the renderer with
type safety. `src/renderer/` is the React app — uses `useElectronAPI()`
to talk to the main process, never reads `window.electronAPI` directly.
`src/shared/` holds types crossed between processes. Adding an IPC
channel means editing three files in the same commit: `ipc-handlers.ts`,
`preload/index.ts`, `preload/index.d.ts`. See `CLAUDE.md` § IPC channel
discipline.
