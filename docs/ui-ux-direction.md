# UI/UX Direction

Canonical reference for the visible surfaces of the NanoClaw / Factotem product. Read this before changing the colour system, the wizard flow, the dashboard layout, or anything visible to a non-developer operator.

This document supersedes ad-hoc decisions in commit messages and code comments. When the design language drifts, update this file in the same commit that introduces the drift.

## The three surfaces

NanoClaw is a single product with three user-facing surfaces. They share a design language but serve different jobs.

**1. The CLI wizard — `nanoclaw/cli/claw-setup/`**

The original 12-step `@clack/prompts` terminal wizard. Stays alive as the **headless install path** — CI environments, SSH sessions, recovery scenarios, and anyone who genuinely prefers a terminal. It is not deprecated and not replaced. The CLI wizard remains the source of truth for setup *logic* (`steps/*.ts` modules), with the GUI re-skinning it rather than re-implementing.

**2. The GUI wizard — `nanoclaw/cli/claw-setup-gui/`**

Electron + React + Tailwind 4 desktop app. The first-time experience for non-technical operators. It exists for two scenarios only:

- First-run setup: the operator double-clicks `NanoClaw Setup.dmg`, drags to Applications, launches it, and is walked through the same steps the CLI wizard would do.
- Repair flow: the operator launches it when something is broken, the GUI detects the broken state via `/health`, and offers troubleshoot affordances.

**The GUI is not a permanent shell.** If `/health` reports all subsystems running, the GUI opens the dashboard in the user's default browser and quits. Don't add features to the GUI that the dashboard could host instead.

**3. The Factotem health dashboard — `nanoclaw/dashboard/`**

Next.js 16 + Tailwind 4 web app. The **canonical post-setup interface.** Polls `/health` every 5 seconds. Shows subsystem status, recent activity, group registrations, OneCLI authentication, container metrics, WhatsApp connection. This is where operators live day-to-day.

The dashboard is also **the design-system source of truth** — see "Visual system" below.

## Hand-off rules

Operator journey, in temporal order:

1. **Download** — `NanoClaw Setup.dmg` from the GitHub release page (drag to Applications).
2. **First launch of the GUI** — probes `/health`. If everything's up (extremely unlikely on first run), opens the dashboard and quits. Otherwise resumes the wizard at the saved step, or starts at Welcome.
3. **Wizard completion** — final step verifies the dashboard responds at `http://localhost:3001`, then shows a single CTA: "Open dashboard". Click → `shell.openExternal()` → `app.quit()`.
4. **Daily use** — the dashboard. The GUI's icon stays in `/Applications` as a recovery / repair tool. The CLI is available for power users.

Anything that breaks this hand-off chain is a UX bug. Examples: a wizard that lingers after completion, a dashboard that requires the wizard to be running, a CLI flow that doesn't write the same state file the GUI does.

## Visual system

**The dashboard's `nanoclaw/dashboard/src/styles/tokens.css` is canonical.** The GUI mirrors it. The two are kept in sync by discipline — there is no symlink, no build-step copy. When you change tokens in one place, change them in both.

Both surfaces share:

- **Palette** — white surfaces (`#ffffff` bg, `#fafafa` subtle bg, `#f5f5f7` elevated panels), near-black ink (`#1d1d1f`), warm orange brand accent (`#ff7a3a`), purple secondary (`#6a00ff`), Apple blue focus ring (`#0071e3`), hairline borders (`#e5e5e7`).
- **Typography** — Comfortaa for the wordmark, system stack for everything else. Letter-spacing scale: `-0.02em` wordmark, `-0.015em` display, `-0.01em` tight, `0` body, `0.015em` caption.
- **Surface treatment** — Apple-flat. Hairline borders (`1px solid #e5e5e7`), shadows in three subtle levels (`shadow-1` 1px/4%, `shadow-2` 8px/6%, `shadow-3` 24px/8%). No glass blur. No gradients except where the warm orange brand surfaces (badges, highlights). No animated backgrounds.
- **Radii** — 8/12/16/24/32px scale (`--radius-sm` through `--radius-2xl`), `9999px` pill.
- **Motion** — `cubic-bezier(0.32, 0.72, 0, 1)` Apple ease. 200ms micro-interactions, 320ms state changes. Respect `prefers-reduced-motion`.

Things the GUI deliberately does **not** inherit from EasyClaw despite the original port:

- Aurora gradient backgrounds → removed
- Floating bubble particles → removed
- Glass-morphism cards → replaced with flat panels + hairlines
- Dark mode default → swapped to light mode default (matches the dashboard)

The EasyClaw aesthetic was a useful scaffold but does not match the operator-facing brand. The dashboard's Apple-flat language is the destination.

## State sync — CLI ↔ GUI

Both wizards read and write `~/.config/nanoclaw/setup-state.json`. The schema lives in two files that **must stay byte-compatible**:

- `nanoclaw/cli/claw-setup/src/state.ts` (canonical, zod-validated)
- `nanoclaw/cli/claw-setup-gui/src/main/services/state-store.ts` (mirror)

If you change one, change the other in the same commit and bump `version`. The CLI wizard will reject a state file whose version it doesn't recognise.

The same rule applies to the orchestrator's `Health` type:

- `nanoclaw/dashboard/src/lib/nanoclaw.ts` (canonical)
- `nanoclaw/cli/claw-setup-gui/src/shared/types.ts` (mirror, used by the boot-time `/health` probe)

## When in doubt

If you find yourself making a visual decision the dashboard hasn't already made, you're probably doing too much. Check `dashboard/src/components/ui/*` for the primitive (Card, Badge, Button, Stat, Dialog, Table); if it exists there, mirror it. If it doesn't exist there, ask whether it belongs in the dashboard first.

The GUI exists to bring people to the dashboard. It should feel like the dashboard's setup page, not its own thing.
