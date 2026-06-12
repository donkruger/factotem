#!/bin/zsh
set -euo pipefail

# set-auth-mode.sh — switch NanoClaw's Anthropic auth mode.
#
# Modes (the injection header DIFFERS by credential type — Anthropic accepts
# an API key on x-api-key, but an OAuth token ONLY on Authorization: Bearer):
#   api-key           — OneCLI holds a non-rotating Anthropic API key
#                       (sk-ant-api…), injected as `x-api-key: {value}`.
#                       Watcher must be absent or it will overwrite the key.
#   subscription      — OneCLI holds a long-lived `claude setup-token` OAuth
#                       token (sk-ant-oat…), injected as
#                       `Authorization: Bearer {value}`. Static (~1yr), no
#                       watcher. The recommended subscription path.
#   oauth-workaround  — OneCLI holds a keychain-rotated OAuth token
#                       (sk-ant-oat…), injected as `Authorization: Bearer
#                       {value}`; the launchd watcher `com.nanoclaw.oauth-
#                       refresh` keeps it in sync with the macOS keychain.
#
# Usage:
#   scripts/set-auth-mode.sh status
#   scripts/set-auth-mode.sh api-key [--value sk-ant-api...]
#   scripts/set-auth-mode.sh subscription --value sk-ant-oat...
#   scripts/set-auth-mode.sh oauth-workaround
#
# Source of truth: ~/.config/nanoclaw/auth-mode (plain text, one line).

# NOTE: this constant is duplicated in ~/.local/bin/nanoclaw-oauth-refresh.sh.
# If you rotate the OneCLI secret's UUID, update both.
ONECLI_SECRET_ID="8104c265-758e-44e1-9e01-5b983f96a379"

KEYCHAIN_SERVICE="Claude Code-credentials"
WATCHER_LABEL="com.nanoclaw.oauth-refresh"
WATCHER_PLIST="$HOME/Library/LaunchAgents/${WATCHER_LABEL}.plist"
WATCHER_CACHE="/tmp/nanoclaw-oauth-last-pushed"

SCRIPT_DIR="$(cd "$(dirname "${(%):-%x}")" && pwd)"
NANOCLAW_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
# Marker must live outside Documents/ so the launchd-spawned oauth watcher can
# read it — TCC blocks launchd reads of Documents/ on macOS. Same dir as the
# existing mount-allowlist.json NanoClaw config.
MARKER_DIR="$HOME/.config/nanoclaw"
MARKER_FILE="$MARKER_DIR/auth-mode"

PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$HOME/.local/bin"

ONECLI_BIN="$HOME/.local/bin/onecli"

read_mode() {
  [[ -f "$MARKER_FILE" ]] && head -n 1 "$MARKER_FILE" | tr -d '[:space:]' || echo "unknown"
}

write_mode() {
  mkdir -p "$MARKER_DIR"
  printf '%s\n' "$1" > "$MARKER_FILE"
}

read_keychain_token() {
  security find-generic-password -s "$KEYCHAIN_SERVICE" -w 2>/dev/null \
    | jq -r '.claudeAiOauth.accessToken // empty'
}

stop_containers() {
  local running
  running=$(docker ps --format '{{.Names}}' 2>/dev/null | grep '^nanoclaw-' || true)
  if [[ -n "$running" ]]; then
    echo "$running" | xargs -I {} docker stop {} >/dev/null 2>&1 || true
    echo "  stopped containers: $(echo $running | tr '\n' ' ')"
  else
    echo "  no nanoclaw-* containers running"
  fi
}

probe_auth() {
  local ca agent_token
  ca=$(ls /var/folders/*/*/T/onecli-proxy-ca.pem 2>/dev/null | head -1)
  agent_token=$("$ONECLI_BIN" agents list 2>/dev/null | jq -r '.[] | select(.isDefault==true) | .accessToken')
  if [[ -z "$ca" || -z "$agent_token" ]]; then
    echo "  probe skipped (no CA cert or default-agent token)"
    return 0
  fi
  # Send NO auth header — let OneCLI inject whatever the stored secret
  # configures (x-api-key for an API key, Authorization: Bearer for an OAuth
  # token). A placeholder `x-api-key` here would poison a Bearer-injected
  # OAuth token: Anthropic evaluates x-api-key first and rejects with
  # "invalid x-api-key" even though the Bearer token is valid (2026-06-09).
  local response
  response=$(curl -sS -m 5 -x "http://x:${agent_token}@localhost:10255" --cacert "$ca" \
    -H 'Content-Type: application/json' -H 'anthropic-version: 2023-06-01' \
    -d '{"model":"claude-sonnet-4-6","max_tokens":1,"messages":[{"role":"user","content":"."}]}' \
    https://api.anthropic.com/v1/messages 2>/dev/null)
  if [[ "$response" == *'"rate_limit_error"'* || "$response" == *'"id":"msg_'* ]]; then
    echo "  probe: auth is live (Anthropic accepted the stored credential)"
  elif [[ "$response" == *'"invalid x-api-key"'* || "$response" == *'"authentication_error"'* ]]; then
    echo "  probe: FAIL — Anthropic rejected the stored credential (authentication_error)"
  elif [[ "$response" == *'"credential_not_found"'* ]]; then
    echo "  probe: FAIL — OneCLI could not inject (credential_not_found)"
  else
    echo "  probe: unexpected response: $(echo "$response" | head -c 200)"
  fi
}

watcher_status() {
  # grep -q would SIGPIPE upstream launchctl and trip pipefail; capture via || true instead.
  local row
  row=$(launchctl list | grep "$WATCHER_LABEL" || true)
  if [[ -n "$row" ]]; then
    echo "  watcher: loaded ($row)"
  else
    echo "  watcher: not loaded"
  fi
}

load_watcher() {
  if [[ ! -f "$WATCHER_PLIST" ]]; then
    echo "  ERROR: $WATCHER_PLIST missing — cannot load watcher"
    return 1
  fi
  launchctl bootstrap gui/$(id -u) "$WATCHER_PLIST" 2>/dev/null || true
  echo "  watcher bootstrapped"
}

unload_watcher() {
  launchctl bootout gui/$(id -u)/$WATCHER_LABEL 2>/dev/null || true
  echo "  watcher booted out (if it was loaded)"
}

push_secret() {
  # push_secret <value> [header-name value-format]
  # When a header-name + value-format are given, the injection config is
  # updated alongside the value — required when switching between an API key
  # (x-api-key) and an OAuth token (Authorization: Bearer), since Anthropic
  # rejects an OAuth token sent on x-api-key.
  local value="$1"; shift
  if [[ $# -ge 2 ]]; then
    "$ONECLI_BIN" secrets update --id "$ONECLI_SECRET_ID" --value "$value" \
      --header-name "$1" --value-format "$2" >/dev/null
    echo "  onecli secrets update: pushed value + injection ($1: $2) to $ONECLI_SECRET_ID"
  else
    "$ONECLI_BIN" secrets update --id "$ONECLI_SECRET_ID" --value "$value" >/dev/null
    echo "  onecli secrets update: pushed new value to $ONECLI_SECRET_ID"
  fi
}

cmd_status() {
  echo "Auth mode status"
  echo "  marker file: $MARKER_FILE"
  echo "  mode: $(read_mode)"
  watcher_status
  local health="/tmp/nanoclaw-oauth-refresh.health"
  if [[ -f "$health" ]]; then
    local age
    age=$(( $(date +%s) - $(stat -f %m "$health") ))
    echo "  watcher last tick: ${age}s ago — $(cat "$health")"
  else
    echo "  watcher last tick: no health file (watcher has not run yet, or not in oauth-workaround mode)"
  fi
  probe_auth
}

cmd_api_key() {
  local new_value=""
  if [[ $# -ge 1 && "$1" == "--value" ]]; then
    shift
    [[ $# -ge 1 ]] || { echo "ERROR: --value requires an argument" >&2; exit 2; }
    new_value="$1"
  fi

  echo "Switching to api-key mode"
  write_mode "api-key"
  echo "  marker: api-key"
  unload_watcher
  if [[ -n "$new_value" ]]; then
    push_secret "$new_value" x-api-key '{value}'
    rm -f "$WATCHER_CACHE" /tmp/nanoclaw-oauth-refresh.health
    echo "  watcher cache + health file cleared"
  else
    echo "  NOTE: no --value supplied; OneCLI still holds the previous credential"
    echo "  WARNING: injection NOT reset to x-api-key — if the previous"
    echo "           credential was an OAuth token, re-run with --value sk-ant-api..."
  fi
  stop_containers
  probe_auth
  echo "Done. Log the switchover in ben-log/ per project CLAUDE.md."
}

cmd_subscription() {
  local new_value=""
  if [[ $# -ge 1 && "$1" == "--value" ]]; then
    shift
    [[ $# -ge 1 ]] || { echo "ERROR: --value requires an argument" >&2; exit 2; }
    new_value="$1"
  fi
  [[ -n "$new_value" ]] || {
    echo "ERROR: subscription mode requires --value sk-ant-oat... (from 'claude setup-token')" >&2
    exit 2
  }
  case "$new_value" in
    sk-ant-oat*) ;;
    *) echo "ERROR: --value must be an OAuth token (sk-ant-oat...). Use 'api-key' for sk-ant-api keys." >&2; exit 2 ;;
  esac

  echo "Switching to subscription mode (long-lived setup-token)"
  write_mode "subscription"
  echo "  marker: subscription"
  # The watcher would overwrite a pasted setup-token with the keychain value.
  unload_watcher
  push_secret "$new_value" Authorization 'Bearer {value}'
  rm -f "$WATCHER_CACHE" /tmp/nanoclaw-oauth-refresh.health
  echo "  watcher cache + health file cleared"
  stop_containers
  probe_auth
  echo "Done. Log the switchover in ben-log/ per project CLAUDE.md."
}

cmd_oauth_workaround() {
  echo "Switching to oauth-workaround mode"
  write_mode "oauth-workaround"
  echo "  marker: oauth-workaround"
  local token
  token=$(read_keychain_token)
  if [[ -z "$token" ]]; then
    echo "  ERROR: could not read OAuth token from keychain; aborting" >&2
    exit 1
  fi
  push_secret "$token" Authorization 'Bearer {value}'
  printf '%s' "$token" > "$WATCHER_CACHE"
  chmod 600 "$WATCHER_CACHE"
  echo "  watcher cache seeded with current keychain token"
  load_watcher
  stop_containers
  probe_auth
  echo "Done."
}

main() {
  local action="${1:-}"
  case "$action" in
    status) cmd_status ;;
    api-key) shift; cmd_api_key "$@" ;;
    subscription) shift; cmd_subscription "$@" ;;
    oauth-workaround) cmd_oauth_workaround ;;
    ""|-h|--help)
      sed -n '4,25p' "$0"
      exit 0
      ;;
    *)
      echo "Unknown action: $action" >&2
      echo "Run with no args for usage." >&2
      exit 2
      ;;
  esac
}

main "$@"
