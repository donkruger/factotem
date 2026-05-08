# Deployment Conventions

A self-contained briefing for anyone — human contributor or downstream agent — about
to ship a Factotem / NanoClaw release. The five-minute version.

For the long-form maintainer runbook (asset inventory, signing certs, rollback
procedure, upgrade-path table per version), see [RELEASES.md](RELEASES.md). For
the long-run trajectory that any change should respect, see [VISION.md](VISION.md).

## When to read this doc

- You're cutting a Doctor release and need the version-bump checklist + tag flow.
- You're proposing a change that affects how operators receive updates, and want to know which surfaces are load-bearing.
- You're handing context to a downstream agent and want to paste a single doc URL.

If you only need the runbook for an in-progress incident, [OPERATIONS.md](OPERATIONS.md) is the right doc instead.

## Two repositories

| Repo | Visibility | Role |
|---|---|---|
| **`donkruger/factotem`** | Public | Source repo. CI builds + signs + notarises here. All commits + tags live here. Operators clone from this URL on first install. |
| **`RichardBNel/Factotem`** | Public | Release mirror only — receives the signed `.dmg` + `.app.tar.gz` + `.sig` + `latest.json` via `MIRROR_REPO_TOKEN`. Has only a README in source; the orchestrator/dashboard/wizard code lives ONLY in `donkruger/factotem`. The Doctor's auto-updater polls `latest.json` from this mirror every 4h. |

**The source repo's visibility is load-bearing.** Three operator-facing surfaces depend on unauthenticated clone/pull access to `donkruger/factotem`:

1. The Doctor's "Set up NanoClaw…" welcome flow runs `git clone https://github.com/donkruger/factotem.git` without auth.
2. The Doctor's "Pull upstream updates…" tray action (v0.1.8+) runs `git pull --ff-only origin main`.
3. The `/update-nanoclaw` Claude Code skill does the same selectively.

If we ever take the source private, all three break for non-collaborators. See [VISION.md § Pillar 4](VISION.md#4-wizard--fully-housed-app-wrapper) for the path that closes this constraint.

## Two distribution paths

NanoClaw splits into **auto-updateable** and **fork-and-modify** components. This
isn't accidental — operators customise the latter (skills, `.env`, per-group
`CLAUDE.md`); auto-overwriting their fork would clobber that work.

| Component | Distribution |
|---|---|
| **Factotem Doctor** (Tauri menu-bar app) | Signed `.dmg`. Tagged releases. Auto-updates via Tauri updater polling `latest.json` every 4h. Operator approves install via Settings. |
| **Orchestrator + dashboard + claw-setup wizard** | `git pull && npm run build`. Three update paths in order of recommendation: Doctor "Pull upstream updates…" (v0.1.8+, un-customised forks) → `/update-nanoclaw` skill (customised forks) → manual `git pull && npm run build` (always works). See [OPERATIONS.md § Updating the Orchestrator](OPERATIONS.md#updating-the-orchestrator). |

## Cutting a Doctor release

For each release `vX.Y.Z`:

### 1. Bump versions in five files

All mechanical:

| File | Change |
|---|---|
| `cli/claw-doctor/package.json` | `"version": "X.Y.Z"` |
| `cli/claw-doctor/src-tauri/Cargo.toml` | `version = "X.Y.Z"` |
| `cli/claw-doctor/src-tauri/tauri.conf.json` | `"version": "X.Y.Z"` |
| `cli/claw-doctor/package-lock.json` | regenerate via `npm install --package-lock-only --silent` |
| `cli/claw-doctor/src-tauri/Cargo.lock` | regenerate via `cd src-tauri && cargo check --offline` |

The CI workflow rejects mismatches between these files at build time, so
regenerate both lockfiles in the same commit as the manual bumps.

### 2. Add a CHANGE_LOG entry

Top of [CHANGE_LOG.md](CHANGE_LOG.md), under today's `## YYYY-MM-DD` heading:

```markdown
### Phase 3 / Doctor vX.Y.Z — <one-line title>

<Two-or-three-paragraph entry explaining what changed, why, and any
operator-visible behaviour.>

**Files.** <list of touched files>.

**Recovery tag.** `pre-doctor-X.Y.Z-YYYY-MM-DD` (at `<previous-tip-sha>`).
```

CI extracts release notes from this section by `awk`-ing between the first two
`## YYYY-MM-DD` headings, so date-sort and entry shape matter.

### 3. Build sweep locally

Before tagging:

```bash
# Doctor
cd cli/claw-doctor && npm run build && cd src-tauri && cargo check --offline

# Orchestrator + tests
cd /path/to/repo && npm run build && npm test    # 352 tests should pass

# Dashboard
npm --prefix dashboard run build
```

### 4. Commit + push to `origin/main`

Don't tag yet. CI watches for `v*` tag pushes, not main pushes.

### 5. Stamp the recovery marker

At the *previous* tip — not at HEAD. Operator-facing: rollback target if `vX.Y.Z`
is broken.

```bash
git tag pre-doctor-X.Y.Z-YYYY-MM-DD <previous-tip-sha>
git push origin pre-doctor-X.Y.Z-YYYY-MM-DD
```

### 6. Tag the release at HEAD

```bash
git tag vX.Y.Z HEAD
git push origin vX.Y.Z
```

This triggers `.github/workflows/release.yml`.

### 7. Watch the workflow

```bash
gh run list --repo donkruger/factotem --workflow release.yml --limit 1
gh run watch <run-id> --repo donkruger/factotem --exit-status
```

Build takes **~12-19 minutes** end-to-end (cargo build + Apple notarisation +
DMG notarisation + cross-repo mirror push).

### 8. Verify on the public mirror

```bash
gh release view vX.Y.Z --repo RichardBNel/Factotem \
  --json tagName,publishedAt,assets \
  --jq '{tag, published: .publishedAt, asset_count: (.assets | length)}'
```

Should report `asset_count: 5`. The five artifacts:

- `Factotem-Doctor.dmg` — versionless stable URL
- `Factotem-Doctor_X.Y.Z_aarch64.dmg` — versioned copy
- `Factotem-Doctor_X.Y.Z_aarch64.app.tar.gz` — Tauri updater payload
- `Factotem-Doctor_X.Y.Z_aarch64.app.tar.gz.sig` — Ed25519 signature
- `latest.json` — Tauri updater manifest

## Workflow noise to ignore

The release workflow's "Verify Gatekeeper acceptance" step has a known flake:

- `##[warning]spctl rejected`
- `##[warning]stapler rejected`

These are pre-existing across at least v0.1.6 → v0.1.9 and don't fail the
build. The `find /Volumes/Factotem` mount-point lookup occasionally returns
empty, so `spctl --assess "" || echo "::warning::..."` fires the warning. The
*actual* notarisation and stapling happen in step 19 and succeed; operators
never see Gatekeeper rejection at install time.

When the verification step gets its own fix (mount-point detection that
doesn't race), this section can come out.

## Tag namespace

| Pattern | Purpose |
|---|---|
| `vX.Y.Z` | Doctor release tag. Triggers CI. Single-source-of-truth for the auto-updater. |
| `pre-doctor-X.Y.Z-YYYY-MM-DD` | Recovery marker stamped at the tip *before* the release commit. Rollback target if `vX.Y.Z` ships broken. |
| `pre-w1-2026-05-08`, `pre-doctor-0.1.7-2026-05-08`, etc. | Historical recovery markers — same shape, varying milestone names. Stable. |

## Things to NOT do without explicit instruction

- **Don't push directly to `RichardBNel/Factotem` source.** CI handles cross-repo write via `MIRROR_REPO_TOKEN`. Manual push will desync the mirror's tree from the source's tagged commits.
- **Don't take `donkruger/factotem` private.** Three operator-facing surfaces (clone in welcome flow, Pull updates, `/update-nanoclaw` skill) all assume unauthenticated HTTPS access. The fix path is a Tauri-based GUI wizard that bundles source — see [VISION.md § Pillar 4](VISION.md#4-wizard--fully-housed-app-wrapper).
- **Don't skip the recovery tag.** Operators need a rollback target if a release ships broken.
- **Don't force-push to `main`.** Period.
- **Don't commit `dashboard/out/`, `dashboard/.next/`, `cli/claw-doctor/src-tauri/target/`, or `dashboard/tsconfig.tsbuildinfo`.** All gitignored, all easy to slip.
- **Don't bundle large dependencies into the Doctor `.dmg`** without checking the auto-updater payload size. Current `.dmg` is ~3.3 MB; staying under 10 MB keeps the auto-update fast over slow connections.
- **Don't skip pre-commit hooks** (`--no-verify`) unless explicitly asked. The husky `format:fix` hook is what keeps prettier drift from accumulating.

## Source-of-truth documents

| Doc | What it owns |
|---|---|
| [RELEASES.md](RELEASES.md) | Maintainer runbook — asset inventory, version-bump checklist (more detailed than this doc's), upgrade-path table per version, manual downgrade procedure, CI secrets list. **The canonical detailed reference for distribution mechanics.** |
| [CHANGE_LOG.md](CHANGE_LOG.md) | Reverse-chronological entries. CI extracts release notes from here. Format: `## YYYY-MM-DD` heading + `### Phase N / Doctor vX.Y.Z — title` subsections. |
| [VISION.md](VISION.md) | Long-run trajectory. Five pillars. Phase-mapping table that should be updated when each release ships. **Read before designing any non-trivial change** — the project's design constraints live here. |
| [OPERATIONS.md](OPERATIONS.md) | Operator-side runbook: startup, recovery, updating, troubleshooting. |
| [SETUP_WIZARD.md](SETUP_WIZARD.md) | Wizard step list + flag semantics. Update the step-table notes when wizard behaviour changes. |
| [REQUIREMENTS.md](REQUIREMENTS.md) | Philosophy + design decisions. Where the v1 single-operator picture lives; v2/v3 evolution lives in VISION.md. |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Current-state architecture. Updated alongside material code changes. |
| [../README.md](../README.md) | Public-facing pitch. Phases table. Release links. Cross-link hub. |
| [../CLAUDE.md](../CLAUDE.md) | What every Claude Code session in this repo loads at start. References VISION.md as the planning checklist. |

## Operator update paths (how releases reach machines)

In recommended order:

1. **Doctor auto-update** (binary only). Polls `latest.json` from public mirror every 4h. Operator approves install via Settings. Restart picks up the new binary.
2. **Doctor → "Pull upstream updates…"** (v0.1.8+). Source-tree update for un-customised forks. Preflight: working tree clean, on `main`, no diverged commits. Then `git pull --ff-only` + `npm install` + `npm run build` + dashboard build + `launchctl kickstart -k gui/$(id -u)/com.nanoclaw`.
3. **`/update-nanoclaw` skill** (Claude Code). For customised forks with local commits — selective cherry-pick.
4. **Manual `git pull && npm run build`**. Always-works fallback. Documented in [OPERATIONS.md § Updating the Orchestrator](OPERATIONS.md#updating-the-orchestrator).

## Verification commands

After any release, paste these on the operator-side machine to confirm the
deployment matches what's on `origin/main`:

```bash
# 1. Source matches origin/main? Both numbers should be identical.
cd ~/factotem && git fetch origin && \
  echo "  HEAD:        $(git rev-parse HEAD)" && \
  echo "  origin/main: $(git rev-parse origin/main)"

# 2. Running orchestrator restarted recently? uptime_seconds should be small after a Pull.
curl -s http://localhost:7842/health | jq '{
  version: .nanoclaw.version,
  uptime_seconds: .nanoclaw.uptime_seconds,
  open_dm: .open_dm
}'

# 3. Dashboard has the latest features? /persona/ exists from v0.1.7+.
curl -s -o /dev/null -w "/persona/: %{http_code}\n" http://localhost:7842/persona/

# 4. Latest published Doctor release?
gh release view --repo RichardBNel/Factotem --json tagName,publishedAt --jq .
```

Pass criteria:

- HEAD == origin/main → source is synced.
- `uptime_seconds < 60` (immediately after a Pull) → orchestrator restarted with the new build.
- `version != "unknown"` → orchestrator built from a real package.json (v0.1.7+).
- `/persona/: 200` → dashboard rebuilt with v0.1.7+ routes.
- Latest release tag matches the most recent v* tag on `donkruger/factotem`.

## Where to ask "how does this work?"

- Distribution mechanics → [RELEASES.md](RELEASES.md).
- Where the project is going → [VISION.md](VISION.md).
- "Why does it look like that?" → [REQUIREMENTS.md](REQUIREMENTS.md) + [ARCHITECTURE.md](ARCHITECTURE.md).
- Operator-side recovery + upgrade → [OPERATIONS.md](OPERATIONS.md).
- This doc itself → keep it short. Detail belongs in the linked targets.

## When to update this doc

- When a new tag-pattern or release-channel convention is added.
- When the version-bump file list changes (e.g. a sixth file enters the dance).
- When the auto-update mechanism gains or loses a path.
- When the workflow noise becomes signal (or fixes itself, and we drop the section).

Don't bloat with per-release content — that belongs in CHANGE_LOG. This doc is
the structural surface, not a history.
