# Factotem Doctor

Cold-start helper + multi-instance-aware status icon for Factotem / NanoClaw.
A small Tauri 2 menu-bar app that runs alongside NanoClaw (supervisor mode)
and surfaces stack health in a system-tray icon.

## Status

**Phase 1 — M1.1 + M1.2 (in progress).** Tray icon + multi-instance-aware
probe layer. The Repair Stack window (M1.3), Settings (M1.4),
code-signing (M1.5), and `claw-setup` integration (M1.6) follow in
subsequent sessions.

See:
- `~/.claude/plans/research/phase-1-tauri-menu-bar-design.md` — the design doc
- `~/.claude/plans/i-want-to-create-stateful-simon.md` — the execution plan

## What it does (M1.2)

- Polls every 5 seconds:
  - `docker info` — Docker engine reachable?
  - `curl 127.0.0.1:10254/` — OneCLI gateway reachable?
  - `pgrep -fla "dist/index.js"` — every NanoClaw orchestrator process
  - `launchctl list` — every launchd label matching `com.nanoclaw*`
  - `lsof -iTCP:7842 -sTCP:LISTEN` — who owns the dashboard port
  - `curl localhost:7842/health` — NanoClaw HTTP server reachable?
- Synthesises a single status: green / amber / red / grey.
- Detects + surfaces multi-instance scenarios:
  - Multiple `com.nanoclaw*` services loaded simultaneously
  - Dev-mode + launchd both running (shared state files)
  - Foreign process holding port 7842
- Tray menu actions: Open Dashboard, Open Recovery Panel, Quit.

## Build

Prerequisites:
- Rust 1.85+ (`rustc --version`)
- Node.js 20+ (`node --version`)
- `cargo-tauri` 2.x (`cargo install tauri-cli@^2.0`)

```bash
cd cli/claw-doctor
npm install
cargo tauri build           # produces src-tauri/target/release/bundle/macos/Factotem Doctor.app
# or
cargo tauri dev             # hot-reload dev mode
```

## Run

After `cargo tauri build`:

```bash
open "src-tauri/target/release/bundle/macos/Factotem Doctor.app"
```

The tray icon appears in the menu bar within ~1 second. First probe
completes ~1 second later; the icon flips to its status colour.

## Quit

Click the tray icon → Quit Factotem Doctor (or ⌘Q).

## File layout

```
cli/claw-doctor/
├── package.json              # frontend deps (Vite + React + Tauri API)
├── vite.config.ts
├── tsconfig.json
├── index.html                # WebView entrypoint (windows in M1.3+)
├── src/                      # React frontend (placeholder in M1.2)
│   └── main.tsx
├── src-tauri/
│   ├── Cargo.toml            # Rust deps (Tauri 2, tokio, reqwest, ...)
│   ├── tauri.conf.json
│   ├── build.rs
│   ├── icons/                # 32x32, 128x128, 128x128@2x, icon.icns,
│   │                         #   tray-template, tray-template@2x
│   ├── recovery-steps.json   # Repair Stack manifest (consumed in M1.3)
│   └── src/
│       ├── main.rs           # entry; tray + tokio + probe scheduler
│       ├── probe.rs          # multi-instance-aware probes (M1.2 core)
│       ├── tray.rs           # tray icon + menu builder
│       ├── commands.rs       # Tauri command handlers + menu router
│       ├── manifest.rs       # recovery-step manifest types + loader
│       └── settings.rs       # operator preferences (placeholder)
└── README.md                 # this file
```

## Convention notes

- The Doctor only **observes** the live system. It never modifies
  NanoClaw source, OneCLI's vault, or launchd plists. Repair Stack
  (M1.3) will run shell commands the operator could run themselves.
- The Doctor coexists with NanoClaw and the future Electron Factotem
  app; it is not absorbed (per Don's supervisor-mode decision).
- Multi-instance detection is built into the probe layer from day one
  rather than retrofitted, because Don's machine has multiple
  `com.nanoclaw*` services loaded today (`com.nanoclaw` +
  `com.nanoclaw-v2-*`).
