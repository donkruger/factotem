#!/usr/bin/env bash
#
# bootstrap.sh — R2 from the 2026-05-08 setup-journey UX audit
# (assessments/2026-05-08-setup-journey-ux.md). The cold-start one-liner
# the Doctor's Welcome window stages into Terminal.
#
# Replaces the previous multi-line incantation
#   git clone https://github.com/donkruger/factotem.git && cd factotem && npm run claw-setup
# with the single-curl idiom non-technical operators have already seen
# from oh-my-zsh, nvm, rustup, etc:
#   curl -fsSL https://github.com/RichardBNel/Factotem/releases/latest/download/bootstrap.sh | sh
#
# Why this exists separately from install-doctor.sh: that script ferries
# the Factotem Doctor .app from the public mirror into /Applications.
# This script ferries the *orchestrator + dashboard + claw-setup wizard*
# source tree onto the host and runs the wizard. Two artefacts, two
# scripts, both fetched from the same public mirror by plain curl —
# no `gh` CLI, no GitHub auth, no Xcode dependency beyond what `git`
# itself triggers via Command Line Tools auto-install.
#
# Layout the script enforces:
#   ~/factotem/                       — orchestrator + dashboard + cli/
#   ~/.config/nanoclaw/setup-state.json — wizard's resumable state
#   /Applications/Factotem Doctor.app   — installed by step 11 of the wizard
#
# The directory choice ($HOME/factotem) is deliberate: the wizard refuses
# to run from ~/Documents/ because of macOS TCC silently killing writes
# from launchd-spawned services (see docs/SETUP_WIZARD.md § macOS TCC
# hard-stop). $HOME/factotem sidesteps that.
#
# Usage:
#   curl -fsSL https://github.com/RichardBNel/Factotem/releases/latest/download/bootstrap.sh | sh
#   bash scripts/bootstrap.sh                           # also works from a checkout
#   FACTOTEM_DIR=~/projects/factotem bash bootstrap.sh  # custom target
#
# Exit codes:
#   0  — wizard launched successfully (or operator chose to defer it)
#   2  — prerequisite missing (git or node) — printed actionable hint
#   3  — clone / install / build failed — printed last 20 lines of output
#   4  — operator aborted

set -euo pipefail

# ──────────────────────────────────────────────────────────────────────────
# Configuration
# ──────────────────────────────────────────────────────────────────────────

FACTOTEM_DIR="${FACTOTEM_DIR:-$HOME/factotem}"
SOURCE_REPO="${SOURCE_REPO:-https://github.com/donkruger/factotem.git}"
NODE_MIN_MAJOR=20

# ──────────────────────────────────────────────────────────────────────────
# Cosmetics — purely visual; the script works fine without colours.
# ──────────────────────────────────────────────────────────────────────────

if [[ -t 1 ]] && command -v tput >/dev/null 2>&1; then
  C_RESET="$(tput sgr0 || true)"
  C_GREEN="$(tput setaf 2 || true)"
  C_YELLOW="$(tput setaf 3 || true)"
  C_RED="$(tput setaf 1 || true)"
  C_DIM="$(tput dim || true)"
  C_BOLD="$(tput bold || true)"
else
  C_RESET=""; C_GREEN=""; C_YELLOW=""; C_RED=""; C_DIM=""; C_BOLD=""
fi

step()    { printf "%s┃%s %s%s%s\n"   "$C_DIM" "$C_RESET" "$C_BOLD" "$*" "$C_RESET"; }
ok()      { printf "  %s✓%s %s\n"     "$C_GREEN"  "$C_RESET" "$*"; }
warn()    { printf "  %s⚠%s %s\n"     "$C_YELLOW" "$C_RESET" "$*"; }
fail()    { printf "  %s✗%s %s\n"     "$C_RED"    "$C_RESET" "$*"; }

heading() {
  printf "\n%s%s%s\n" "$C_BOLD" "$*" "$C_RESET"
  printf "%s%s%s\n"   "$C_DIM"  "────────────────────────────────────────────────────" "$C_RESET"
}

# ──────────────────────────────────────────────────────────────────────────
# Preflight — fail fast with actionable hints
# ──────────────────────────────────────────────────────────────────────────

heading "Factotem cold-start bootstrap"
printf "%sTarget directory:%s %s\n" "$C_DIM" "$C_RESET" "$FACTOTEM_DIR"
printf "%sSource repo:     %s %s\n" "$C_DIM" "$C_RESET" "$SOURCE_REPO"

step "Checking prerequisites"

if ! command -v git >/dev/null 2>&1; then
  fail "git is missing."
  warn "On macOS, just running \`git --version\` triggers the Xcode Command"
  warn "Line Tools installer dialog. Let it finish, then re-run this script."
  exit 2
fi
ok "git $(git --version | awk '{print $3}')"

if ! command -v node >/dev/null 2>&1; then
  fail "node is missing."
  warn "Install Node.js ${NODE_MIN_MAJOR}+ from https://nodejs.org/ (use the LTS .pkg installer)"
  warn "then re-run this script."
  exit 2
fi
node_major="$(node --version | sed -E 's/^v([0-9]+).*/\1/')"
if (( node_major < NODE_MIN_MAJOR )); then
  fail "node $(node --version) is too old; need ≥ v${NODE_MIN_MAJOR}."
  warn "Install Node.js ${NODE_MIN_MAJOR}+ from https://nodejs.org/ (use the LTS .pkg installer)"
  warn "then re-run this script."
  exit 2
fi
ok "node $(node --version) (≥ v${NODE_MIN_MAJOR})"

# ──────────────────────────────────────────────────────────────────────────
# TCC guard — refuse to clone under ~/Documents/
# (matches cli/claw-setup/src/index.ts::inDocumentsRoot)
# ──────────────────────────────────────────────────────────────────────────

if [[ "$(uname)" == "Darwin" && "$FACTOTEM_DIR" == /Users/*/Documents/* ]]; then
  fail "FACTOTEM_DIR=$FACTOTEM_DIR is under ~/Documents/."
  warn "macOS TCC silently denies writes from launchd-spawned services there."
  warn "Pick a path outside ~/Documents/ (e.g. \$HOME/factotem) and re-run:"
  warn "  FACTOTEM_DIR=\$HOME/factotem bash $0"
  exit 2
fi

# ──────────────────────────────────────────────────────────────────────────
# Clone or update
# ──────────────────────────────────────────────────────────────────────────

step "Fetching the orchestrator source tree"

if [[ -d "$FACTOTEM_DIR/.git" ]]; then
  ok "$FACTOTEM_DIR already exists — running \`git pull --ff-only\`"
  cd "$FACTOTEM_DIR"
  if ! git pull --ff-only 2>&1 | tail -20; then
    fail "git pull failed."
    warn "Resolve the working-tree state in $FACTOTEM_DIR by hand, or"
    warn "rename it and re-run this script for a fresh clone."
    exit 3
  fi
elif [[ -e "$FACTOTEM_DIR" ]]; then
  fail "$FACTOTEM_DIR exists but isn't a git checkout."
  warn "Move it aside or pick a different FACTOTEM_DIR, then re-run."
  exit 3
else
  parent_dir="$(dirname "$FACTOTEM_DIR")"
  mkdir -p "$parent_dir"
  ok "Cloning $SOURCE_REPO into $FACTOTEM_DIR"
  if ! git clone --depth 1 "$SOURCE_REPO" "$FACTOTEM_DIR" 2>&1 | tail -20; then
    fail "git clone failed."
    warn "Check your network, or clone manually:"
    warn "  git clone $SOURCE_REPO $FACTOTEM_DIR"
    exit 3
  fi
  cd "$FACTOTEM_DIR"
fi

# ──────────────────────────────────────────────────────────────────────────
# Install + run wizard
# ──────────────────────────────────────────────────────────────────────────

step "Installing JavaScript dependencies (one-time, ~30s)"
if ! npm install --silent 2>&1 | tail -20; then
  fail "npm install failed."
  warn "Try running it manually for full output:"
  warn "  cd $FACTOTEM_DIR && npm install"
  exit 3
fi
ok "Dependencies installed."

step "Launching the cold-start wizard"
printf "\n%sThe wizard will guide you through:%s\n" "$C_DIM" "$C_RESET"
printf "  • Profile + persona name (the @-trigger your agent responds to)\n"
printf "  • Probe Docker / Tailscale (auto-launches Docker if installed)\n"
printf "  • OneCLI gateway + Anthropic credential\n"
printf "  • Build agent container (~3–5 min the first time)\n"
printf "  • Pair WhatsApp via QR code\n"
printf "  • Smoke test + Doctor install\n\n"

# `npm run claw-setup` resolves to the wizard's compiled entrypoint and
# applies the project's standard build chain. Resumable via:
#   npm run claw-setup -- --resume
exec npm run claw-setup
