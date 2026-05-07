#!/usr/bin/env bash
#
# install-recovery.sh — Phase 0 of the embedded startup-recovery experience.
#
# Installs `recovery.html` to the macOS Application Support directory and
# symlinks it onto the Desktop so the operator can find it after a cold-start
# (when the dashboard itself is unreachable). Idempotent — safe to re-run.
#
# Source of truth for the recovery panel content: scripts/recovery/recovery.html
# in this repo. This script just ferries it to its runtime location.
#
# Phase 1 (Tauri menu-bar app) will replace the Desktop symlink with a
# proper app bundle in /Applications. The recovery.html itself remains
# the canonical content surface.
#
# Usage:
#   bash scripts/install-recovery.sh                # install / refresh
#   bash scripts/install-recovery.sh --uninstall    # remove
#   bash scripts/install-recovery.sh --verify       # check current state

set -euo pipefail

SCRIPT_DIR="$( cd -- "$( dirname -- "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )"
SOURCE_HTML="$SCRIPT_DIR/recovery/recovery.html"
APP_SUPPORT_DIR="$HOME/Library/Application Support/Factotem"
TARGET_HTML="$APP_SUPPORT_DIR/recovery.html"
DESKTOP_SHORTCUT="$HOME/Desktop/Factotem Recovery.html"

mode="install"
case "${1:-}" in
  --uninstall) mode="uninstall" ;;
  --verify)    mode="verify" ;;
  --help|-h)
    sed -n '/^# install-recovery.sh/,/^# Usage:/p' "$0" | sed 's/^# \?//'
    exit 0
    ;;
esac

# ──────────────────────────────────────────────────────────────────────────
# Helpers
# ──────────────────────────────────────────────────────────────────────────

is_macos() { [[ "$(uname)" == "Darwin" ]]; }

emit_result() {
  local key="$1" value="$2"
  printf "  %-22s %s\n" "$key" "$value"
}

# ──────────────────────────────────────────────────────────────────────────
# Verify mode — read-only check
# ──────────────────────────────────────────────────────────────────────────

if [[ "$mode" == "verify" ]]; then
  echo "Factotem recovery — current state:"
  if [[ -f "$SOURCE_HTML" ]]; then
    emit_result "source"        "✓ $SOURCE_HTML"
  else
    emit_result "source"        "✗ missing — repo may be incomplete"
  fi
  if [[ -f "$TARGET_HTML" ]]; then
    emit_result "installed copy" "✓ $TARGET_HTML"
  else
    emit_result "installed copy" "✗ not installed"
  fi
  if [[ -L "$DESKTOP_SHORTCUT" ]] || [[ -f "$DESKTOP_SHORTCUT" ]]; then
    emit_result "Desktop shortcut" "✓ $DESKTOP_SHORTCUT"
  else
    emit_result "Desktop shortcut" "✗ not present"
  fi
  exit 0
fi

# ──────────────────────────────────────────────────────────────────────────
# Uninstall mode
# ──────────────────────────────────────────────────────────────────────────

if [[ "$mode" == "uninstall" ]]; then
  echo "Removing Factotem recovery resources…"
  rm -f "$DESKTOP_SHORTCUT"
  rm -f "$TARGET_HTML"
  # Only remove the directory if it's empty — don't clobber unrelated files.
  if [[ -d "$APP_SUPPORT_DIR" ]] && [[ -z "$(ls -A "$APP_SUPPORT_DIR" 2>/dev/null || true)" ]]; then
    rmdir "$APP_SUPPORT_DIR"
  fi
  echo "✓ Uninstalled."
  exit 0
fi

# ──────────────────────────────────────────────────────────────────────────
# Install mode (default)
# ──────────────────────────────────────────────────────────────────────────

if ! is_macos; then
  echo "ℹ This script is currently macOS-only. The recovery.html itself"
  echo "  works on any OS — copy it manually to a discoverable location."
  exit 0
fi

if [[ ! -f "$SOURCE_HTML" ]]; then
  echo "✗ Source HTML not found at $SOURCE_HTML" >&2
  echo "  Run this script from the nanoclaw repo root." >&2
  exit 1
fi

echo "Installing Factotem recovery…"

# 1. Application Support directory + the canonical HTML copy.
mkdir -p "$APP_SUPPORT_DIR"
cp "$SOURCE_HTML" "$TARGET_HTML"
emit_result "installed copy" "$TARGET_HTML"

# 2. Desktop shortcut. Use a symlink rather than a copy so updates flow.
#    Use `ln -sfn` to overwrite atomically without breaking on a stale
#    symlink target.
if [[ -e "$DESKTOP_SHORTCUT" || -L "$DESKTOP_SHORTCUT" ]]; then
  rm -f "$DESKTOP_SHORTCUT"
fi
ln -s "$TARGET_HTML" "$DESKTOP_SHORTCUT"
emit_result "Desktop shortcut" "$DESKTOP_SHORTCUT"

echo
echo "✓ Done. Double-click 'Factotem Recovery' on the Desktop, or run:"
echo "    open \"$TARGET_HTML\""
echo
echo "  To remove later:"
echo "    bash scripts/install-recovery.sh --uninstall"
