#!/usr/bin/env bash
#
# install-doctor.sh — Phase 1 / M1.6 of the Factotem deployment story.
#
# Installs the signed + notarized Factotem Doctor menu-bar app to
# /Applications and launches it so the tray icon appears immediately.
# Used by the claw-setup wizard's handoff step (best-effort) and
# directly by operators who want to re-install or upgrade the Doctor
# without re-running the wizard.
#
# Source of truth for the .app bundle:
#   cli/claw-doctor/src-tauri/target/release/bundle/macos/Factotem Doctor.app
#
# That path is produced by `cargo tauri build` inside cli/claw-doctor/.
# This script does NOT trigger a build itself — if the source is
# missing it prints the build command and exits non-zero so the wizard's
# best-effort wrapper logs a clean warning rather than hanging.
#
# Usage:
#   bash scripts/install-doctor.sh                # install / refresh
#   bash scripts/install-doctor.sh --uninstall    # remove .app + autostart + settings
#   bash scripts/install-doctor.sh --verify       # check current state

set -euo pipefail

SCRIPT_DIR="$( cd -- "$( dirname -- "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )"
REPO_ROOT="$( cd -- "$SCRIPT_DIR/.." &> /dev/null && pwd )"
SOURCE_APP="$REPO_ROOT/cli/claw-doctor/src-tauri/target/release/bundle/macos/Factotem Doctor.app"
TARGET_APP="/Applications/Factotem Doctor.app"
EXPECTED_BUNDLE_ID="co.factotem.doctor"
LAUNCH_AGENT="$HOME/Library/LaunchAgents/Factotem Doctor.plist"
SETTINGS_FILE="$HOME/Library/Application Support/Factotem/doctor-settings.json"
PROCESS_PATTERN="factotem-doctor"

mode="install"
case "${1:-}" in
  --uninstall) mode="uninstall" ;;
  --verify)    mode="verify" ;;
  --help|-h)
    sed -n '/^# install-doctor.sh/,/^# Usage:/p' "$0" | sed 's/^# \?//'
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

# Read CFBundleIdentifier from a .app's Info.plist; empty string on failure.
bundle_id_of() {
  local app_path="$1"
  local plist="$app_path/Contents/Info.plist"
  [[ -f "$plist" ]] || { echo ""; return; }
  /usr/bin/plutil -extract CFBundleIdentifier raw -o - "$plist" 2>/dev/null || echo ""
}

# Read CFBundleShortVersionString from a .app's Info.plist; empty on failure.
bundle_version_of() {
  local app_path="$1"
  local plist="$app_path/Contents/Info.plist"
  [[ -f "$plist" ]] || { echo ""; return; }
  /usr/bin/plutil -extract CFBundleShortVersionString raw -o - "$plist" 2>/dev/null || echo ""
}

# Kill any running Doctor process. Returns 0 whether it was running or not.
kill_running_doctor() {
  if pgrep -f "$PROCESS_PATTERN" >/dev/null 2>&1; then
    pkill -9 -f "$PROCESS_PATTERN" 2>/dev/null || true
    # Give launchd a beat to update its accounting.
    sleep 0.3
  fi
}

# ──────────────────────────────────────────────────────────────────────────
# Verify mode — read-only check
# ──────────────────────────────────────────────────────────────────────────

if [[ "$mode" == "verify" ]]; then
  echo "Factotem Doctor — current state:"
  if [[ -d "$SOURCE_APP" ]]; then
    emit_result "source bundle"   "✓ $SOURCE_APP ($(bundle_version_of "$SOURCE_APP"))"
  else
    emit_result "source bundle"   "✗ missing — run \`cd cli/claw-doctor && cargo tauri build\`"
  fi
  if [[ -d "$TARGET_APP" ]]; then
    installed_id="$(bundle_id_of "$TARGET_APP")"
    installed_ver="$(bundle_version_of "$TARGET_APP")"
    if [[ "$installed_id" == "$EXPECTED_BUNDLE_ID" ]]; then
      emit_result "installed copy" "✓ $TARGET_APP (v$installed_ver)"
    else
      emit_result "installed copy" "⚠ $TARGET_APP — bundle id is \"$installed_id\" (expected $EXPECTED_BUNDLE_ID)"
    fi
  else
    emit_result "installed copy" "✗ not installed"
  fi
  if pgrep -f "$PROCESS_PATTERN" >/dev/null 2>&1; then
    pid=$(pgrep -f "$PROCESS_PATTERN" | head -1)
    emit_result "running process"  "✓ PID $pid"
  else
    emit_result "running process"  "✗ not running"
  fi
  if [[ -f "$LAUNCH_AGENT" ]]; then
    emit_result "autostart agent"  "✓ $LAUNCH_AGENT"
  else
    emit_result "autostart agent"  "✗ not registered"
  fi
  if [[ -f "$SETTINGS_FILE" ]]; then
    emit_result "settings"         "✓ $SETTINGS_FILE"
  else
    emit_result "settings"         "  (defaults — no settings file written yet)"
  fi
  exit 0
fi

# ──────────────────────────────────────────────────────────────────────────
# Uninstall mode
# ──────────────────────────────────────────────────────────────────────────

if [[ "$mode" == "uninstall" ]]; then
  if ! is_macos; then
    echo "ℹ macOS only. Nothing to uninstall on this OS."
    exit 0
  fi
  echo "Removing Factotem Doctor…"
  kill_running_doctor
  if [[ -d "$TARGET_APP" ]]; then
    rm -rf "$TARGET_APP"
    emit_result "removed app"      "$TARGET_APP"
  fi
  if [[ -f "$LAUNCH_AGENT" ]]; then
    # Best-effort unload first so the next login doesn't try to relaunch
    # a now-removed binary. `bootout` is the modern replacement for
    # `launchctl unload`; ignore failures (job may already be gone).
    launchctl bootout "gui/$(id -u)" "$LAUNCH_AGENT" 2>/dev/null || true
    rm -f "$LAUNCH_AGENT"
    emit_result "removed autostart" "$LAUNCH_AGENT"
  fi
  if [[ -f "$SETTINGS_FILE" ]]; then
    rm -f "$SETTINGS_FILE"
    emit_result "removed settings" "$SETTINGS_FILE"
  fi
  echo "✓ Uninstalled. Re-install with: bash scripts/install-doctor.sh"
  exit 0
fi

# ──────────────────────────────────────────────────────────────────────────
# Install mode (default)
# ──────────────────────────────────────────────────────────────────────────

if ! is_macos; then
  echo "ℹ This script is currently macOS-only — the Doctor is a Tauri"
  echo "  app built against the macOS WebView + tray-icon plugins."
  exit 0
fi

if [[ ! -d "$SOURCE_APP" ]]; then
  echo "✗ Doctor .app not found at:" >&2
  echo "    $SOURCE_APP" >&2
  echo >&2
  echo "  Build it first:" >&2
  echo "    cd cli/claw-doctor && cargo tauri build" >&2
  echo >&2
  echo "  Then re-run this installer:" >&2
  echo "    bash scripts/install-doctor.sh" >&2
  exit 1
fi

# Refuse to overwrite a foreign app that happens to share the name.
if [[ -d "$TARGET_APP" ]]; then
  installed_id="$(bundle_id_of "$TARGET_APP")"
  if [[ -n "$installed_id" && "$installed_id" != "$EXPECTED_BUNDLE_ID" ]]; then
    echo "✗ $TARGET_APP exists with bundle id \"$installed_id\"" >&2
    echo "  (expected $EXPECTED_BUNDLE_ID). Refusing to overwrite an unrelated app." >&2
    echo "  Move or rename the existing app, then re-run." >&2
    exit 1
  fi
fi

echo "Installing Factotem Doctor…"

# 1. Stop any running instance — copying over a live .app risks partial writes.
kill_running_doctor

# 2. Replace /Applications/Factotem Doctor.app via `ditto` (preserves
#    resource forks + xattrs more faithfully than cp -R on macOS, and
#    handles the directory-to-directory replace cleanly).
if [[ -d "$TARGET_APP" ]]; then
  rm -rf "$TARGET_APP"
fi
/usr/bin/ditto "$SOURCE_APP" "$TARGET_APP"
emit_result "installed copy"  "$TARGET_APP ($(bundle_version_of "$TARGET_APP"))"

# 3. Strip the quarantine xattr if present. The .app is notarized so
#    Gatekeeper would accept it on first launch anyway, but a stray
#    quarantine bit (inherited from the originating cargo download)
#    triggers a one-time confirm dialog that we'd rather skip.
if /usr/bin/xattr -p com.apple.quarantine "$TARGET_APP" >/dev/null 2>&1; then
  /usr/bin/xattr -dr com.apple.quarantine "$TARGET_APP" 2>/dev/null || true
  emit_result "quarantine"      "stripped"
fi

# 4. Launch so the menu-bar icon appears immediately. `open` is
#    fire-and-forget; macOS handles the launchd-spawn semantics.
if /usr/bin/open "$TARGET_APP"; then
  emit_result "launched"        "tray icon should appear within 2s"
else
  emit_result "launched"        "(open failed — run \`open \"$TARGET_APP\"\` manually)"
fi

echo
echo "✓ Done. The Factotem Doctor lives in your menu bar."
echo "  Click its icon for: Open Dashboard / Repair Stack / Settings / Logs."
echo
echo "  To re-install later:    bash scripts/install-doctor.sh"
echo "  To uninstall:           bash scripts/install-doctor.sh --uninstall"
echo "  To check current state: bash scripts/install-doctor.sh --verify"
