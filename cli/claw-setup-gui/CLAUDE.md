# claw-setup-gui — Agent Rules

Project-scoped instructions for Claude (and human contributors) working in `nanoclaw/cli/claw-setup-gui/`. These override defaults; follow them.

## What this package is

Electron + React + Tailwind 4 desktop setup wizard for NanoClaw. It is the GUI sibling of `cli/claw-setup/` (which stays as the headless / SRE CLI path). Both wizards share the state file at `~/.config/nanoclaw/setup-state.json` and the visual system documented at `nanoclaw/docs/ui-ux-direction.md`. **Read `ui-ux-direction.md` first** — it explains the three-surface architecture (CLI wizard, GUI wizard, dashboard) and the hand-off rules between them.

**Provider work has its own playbook.** If you're adding a wizard branch for a new AI provider (OpenAI, Gemini, Ollama, anything non-Claude), read [`nanoclaw/docs/PROVIDER_PLAYBOOK.md`](../../docs/PROVIDER_PLAYBOOK.md) before touching any code in `src/renderer/src/steps/`. It defines the per-provider wizard contract (§ 4.2), the wizard-flow integration showing exactly which steps split (§ 3), the operator-language guide for copy (§ 8), and the implementation checklist (§ 9) including acceptance tests.

## Things that MUST stay in sync (any one changes → change them all)

1. **State schema (v3 since the Gemini blueprint)** — `cli/claw-setup/src/state.ts` (canonical) and `cli/claw-setup-gui/src/main/services/state-store.ts` (mirror). Same zod fields, same regex for assistant names, same `version` literal. Includes the `agents` array, `default_agent_id`, and the legacy `assistantName` + `provider_default` mirrors.
2. **Agent + Provider types** — `nanoclaw/src/types.ts` (canonical, orchestrator-side) and `cli/claw-setup-gui/src/shared/types.ts` (mirror). The shapes drive both surfaces' provider routing.
3. **Provider registry** — `nanoclaw/setup/providers.json` (single source of truth, read by orchestrator via `src/providers-registry.ts`, by wizard via `setup/onecli-providers.ts` + the GUI's `src/main/services/providers.ts`). Adding the 9th provider is a JSON edit; the wizard's Provider step renders it automatically. **Don't fork this — every reader hits the same file.**
4. **Health type** — `dashboard/src/lib/nanoclaw.ts` (canonical) and `cli/claw-setup-gui/src/shared/types.ts` (the `HealthSummary` interface).
5. **Design tokens** — `dashboard/src/styles/tokens.css` (canonical) and `cli/claw-setup-gui/src/renderer/src/assets/main.css` (mirror).
6. **`UI` interface** (when prompt methods are added, see Future Work) — `cli/claw-setup/src/types.ts` (canonical) and any `ElectronUI` adapter that implements it.

If you change one half without the other, you've created a bug for the next agent.

## IPC channel discipline (three-file contract)

When you add or rename an IPC channel, you MUST edit three files in the same commit:

1. `src/main/ipc-handlers.ts` — register with `ipcMain.handle('channel:name', handler)`
2. `src/preload/index.ts` — expose to renderer via `ipcRenderer.invoke('channel:name', ...)`
3. `src/preload/index.d.ts` — declare the typed shape on `Window.electronAPI`

Channel names use `area:verb` (e.g. `env:check`, `health:probe`, `dashboard:open`). Never invent a name; check existing channels first.

Renderer code talks to the main process **only** through `useElectronAPI()` (the hook handles the cold-start race where preload may not be attached yet). Never reach for `window.electronAPI.*` directly inside a component — always go through the hook so the readiness guard runs. The hook's existence is the response to the original "preload not loaded" crash; preserve that abstraction.

## Visual system rules

- **Don't introduce new colour tokens.** Pull from `dashboard/src/styles/tokens.css`. If the dashboard doesn't define what you need, the dashboard should define it first.
- **Don't add background animations** (aurora, gradients, particles, blurs). The Apple-flat aesthetic is intentional. EasyClaw's animated visual identity was an early port; it is no longer the direction.
- **Don't add a dark-mode toggle to the wizard.** The dashboard handles theming; the wizard is light-mode only because operators only see it once.
- **Comfortaa is for the wordmark.** Body text uses the system stack. Don't apply Comfortaa to running text.

## State machine rules

The wizard step order is fixed in `src/renderer/src/hooks/useWizard.ts`. Adding a step means adding it there *and* mapping it in `App.tsx`'s render switch. Step IDs are stable identifiers and appear in the state file's `currentStep` and `completedSteps` arrays — they must match the CLI's `cli/claw-setup/src/steps/*.ts` step `id` field whenever the GUI step corresponds to a CLI step.

Per the Gemini blueprint (PR 3, Phase D), the legacy `onecli` step split into `provider` + `credentials` in both surfaces:

- GUI: `ProviderStep.tsx` + `CredentialsStep.tsx` — data-driven from `setup/providers.json` via `window.electronAPI.providers.{list,probeKey,createCredential}`.
- CLI: `03a-provider.ts` + `03b-credentials.ts` (the existing `03-configure-onecli.ts` still runs first to install + auth OneCLI itself, which is provider-independent).

When the operator re-launches the GUI and `setup-state.json` already shows ≥1 agent, the Welcome step swaps its "Re-run setup anyway" CTA for **Add another agent** + **Reconfigure**. The Add path sets `state.data.__mode = 'add-agent'`; the Provider step honours that flag and appends a non-default agent on commit. See `WelcomeStep.tsx` + `ProviderStep.tsx`.

On every app launch, `main/index.ts` probes `/health` before showing the window. If healthy → open the dashboard and quit. Don't bypass this — it's the entire reason the wizard is repair-only post-setup.

## Hand-off to the dashboard

The GUI is **not** a permanent shell. The terminal step (currently `NextStepsStep`, will become a "ReadyStep" once steps 02→11 are wired) ensures the dashboard is reachable at `http://localhost:3001`, then offers a single CTA that calls `dashboard:open` (which `shell.openExternal()`s the URL) and quits the app.

Don't add features that the dashboard could host. If the wizard surface starts to feel like a control panel, you've drifted; route the request to the dashboard instead.

## Things this package deliberately does NOT have (yet)

- **i18n** — English only. The dashboard is also English-only today; both follow whatever localisation strategy the dashboard adopts first.
- **Auto-updater** — `electron-updater` will land after the first release ships and stabilises.
- **System tray icon** — not in scope. The GUI is short-lived; tray presence implies daemon-lifetime, which contradicts the hand-off design.
- **Reboot recovery watchdog** — the state file is resumable; the GUI restarts cleanly from any step. We don't need EasyClaw's reboot daemon.

## Future work (in priority order)

1. Extend `UI` interface in `cli/claw-setup/src/types.ts` with `select` / `text` / `confirm` methods so step modules stop importing `@clack/prompts` directly. This unblocks the `ElectronUI` adapter pattern (renderer collects answers → IPC → adapter satisfies the `UI` call → step module proceeds without knowing it's not in a terminal).
2. Port steps 02 → 11 one at a time, against the now-stable shell.
3. Refactor `nanoclaw/src/whatsapp-auth.ts` to emit QR-as-data over IPC instead of rendering with `qrcode-terminal`. This unblocks the WhatsApp pair step.
4. Real mascot. The current `Mascot.tsx` SVG is a placeholder. The DMG icon and window background block on a commissioned illustration.

## Build & dev

```bash
npm install          # installs dependencies
npm run build        # builds main + preload + renderer to ./out/
npm run dev          # electron-vite dev server (use `npm run build` once first if out/ is empty)
npm run typecheck    # tsc --noEmit for both node + web tsconfigs
npm run release      # version bump → tag → push → gh release create (triggers Actions)
```

Output paths:

- Development bundles: `./out/` (electron-vite default)
- Release artifacts: `./dist/` (electron-builder default — DMG, exe, blockmap, latest-mac.yml)

## When you hit a bug

Look at the main process console first (`npm run dev` prints it). Most "renderer can't reach API" errors are actually preload-load failures and the error there is more useful than the renderer-side `Cannot read properties of undefined`.

For state file weirdness, inspect `~/.config/nanoclaw/setup-state.json` directly. The CLI and GUI both write it; one can leave artefacts the other doesn't expect.

## macOS PATH gotcha (READ THIS BEFORE ADDING SUBPROCESS CALLS)

Electron apps launched from Finder inherit launchd's minimal PATH —
`/usr/bin:/bin:/usr/sbin:/sbin`. That excludes:

- `/usr/local/bin` (Homebrew Intel, npm-globals, OneCLI)
- `/opt/homebrew/bin` (Homebrew Apple Silicon)
- The CLI binaries inside .app bundles (`/Applications/Tailscale.app/Contents/MacOS/Tailscale`, `/Applications/Docker.app/Contents/Resources/bin/docker`)

Symptom: the user has `tailscale` running and `which tailscale` succeeds
from their shell, but the wizard's "Tailscale not found" probe fires
anyway. Same root cause as the orchestrator's `spawn npx ENOENT` issue
documented in the top-level `nanoclaw/CLAUDE.md` § Troubleshooting.

**Always use `src/main/services/path-utils.ts`:**

- `findBin(name)` — returns an absolute path to the binary, checking
  .app bundle locations first, then the augmented PATH. Use this
  instead of `which`.
- `envWithPath()` — returns a `process.env`-shaped object with the
  augmented PATH. `subprocess.ts`'s `runCommand` and `startRun` apply
  this by default; if you call `spawn()` directly you must apply it
  manually.

Never write `spawn('tailscale', ...)` or `runCommand('which', ['onecli'])`
in this codebase — go through `findBin()` so the user's working
installation gets discovered even when their PATH would otherwise miss it.
