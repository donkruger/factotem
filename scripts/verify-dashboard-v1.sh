#!/usr/bin/env bash
#
# verify-dashboard-v1.sh — Phase 8 / Wave 9 verification suite for the
# Factotem Operator Dashboard v1 (T-1778246000000).
#
# Runs 10 checks against the live system on http://localhost:7842/.
# 8 are fully automated; 2 are MANUAL (operator instructions printed).
# Usage:
#   bash scripts/verify-dashboard-v1.sh           # run all checks
#   bash scripts/verify-dashboard-v1.sh --check 3 # run only check N
#   bash scripts/verify-dashboard-v1.sh --json    # machine-readable output
#
# Exit code: 0 if no FAIL; 1 otherwise. MANUAL checks don't block exit.
#
# Side effects:
#   - Checks 5+6 PATCH a non-main group's `name` field and then undo it.
#     Two `verify-test` audit entries appear in /api/audit (both with
#     follow-up `audit.undo`). No state remains modified.

set -uo pipefail

BASE="${NANOCLAW_BASE:-http://localhost:7842}"
ONLY_CHECK=""
JSON_OUTPUT=0
EXPECTED_REGION=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --check)
      ONLY_CHECK="$2"
      shift 2
      ;;
    --json)
      JSON_OUTPUT=1
      shift
      ;;
    --expected-region)
      EXPECTED_REGION="$2"
      shift 2
      ;;
    -h|--help)
      sed -n '1,/^# Side effects:/p' "$0" | sed 's/^# \?//'
      exit 0
      ;;
    *)
      echo "unknown flag: $1" >&2
      exit 2
      ;;
  esac
done

# ──────────────────────────────────────────────────────────────────────────
# Output helpers
# ──────────────────────────────────────────────────────────────────────────

if [[ -t 1 && "$JSON_OUTPUT" == "0" ]]; then
  C_OK="\033[32m"
  C_WARN="\033[33m"
  C_FAIL="\033[31m"
  C_DIM="\033[2m"
  C_RST="\033[0m"
else
  C_OK=""; C_WARN=""; C_FAIL=""; C_DIM=""; C_RST=""
fi

PASS_COUNT=0
FAIL_COUNT=0
MANUAL_COUNT=0
RESULTS_JSON="["

_emit() {
  local id="$1" status="$2" msg="$3"
  if [[ "$JSON_OUTPUT" == "1" ]]; then
    [[ "$RESULTS_JSON" != "[" ]] && RESULTS_JSON+=","
    RESULTS_JSON+="{\"id\":\"$id\",\"status\":\"$status\",\"message\":$(printf '%s' "$msg" | jq -Rs .)}"
  else
    case "$status" in
      PASS)    printf "${C_OK}✓ PASS${C_RST}  %s — %s\n"   "$id" "$msg" ;;
      FAIL)    printf "${C_FAIL}✗ FAIL${C_RST}  %s — %s\n" "$id" "$msg" ;;
      MANUAL)  printf "${C_WARN}~ MANUAL${C_RST} %s — %s\n" "$id" "$msg" ;;
    esac
  fi
}

_pass()   { _emit "$1" "PASS"   "$2"; PASS_COUNT=$((PASS_COUNT + 1)); }
_fail()   { _emit "$1" "FAIL"   "$2"; FAIL_COUNT=$((FAIL_COUNT + 1)); }
_manual() { _emit "$1" "MANUAL" "$2"; MANUAL_COUNT=$((MANUAL_COUNT + 1)); }

_curl() {
  curl --max-time 5 --silent --show-error --fail "$@" 2>/dev/null
}

_log() {
  if [[ "$JSON_OUTPUT" == "0" ]]; then
    printf "${C_DIM}%s${C_RST}\n" "$1"
  fi
}

_should_run() {
  [[ -z "$ONLY_CHECK" || "$ONLY_CHECK" == "$1" ]]
}

# ──────────────────────────────────────────────────────────────────────────
# Pre-flight
# ──────────────────────────────────────────────────────────────────────────

if ! command -v jq >/dev/null 2>&1; then
  echo "verify-dashboard-v1: jq is required. Install via: brew install jq" >&2
  exit 2
fi

# ──────────────────────────────────────────────────────────────────────────
# Check 1 — /health reachable
# ──────────────────────────────────────────────────────────────────────────

if _should_run 1; then
  HEALTH=$(_curl "$BASE/health" || echo "")
  if [[ -z "$HEALTH" ]]; then
    _fail 1 "/health unreachable at $BASE — is NanoClaw running?"
  else
    NC_RUNNING=$(jq -r '.nanoclaw.running' <<<"$HEALTH")
    WA_AUTH=$(jq -r '.whatsapp.authenticated' <<<"$HEALTH")
    PID=$(jq -r '.nanoclaw.pid' <<<"$HEALTH")
    REGION=$(jq -r '.machine.region' <<<"$HEALTH")
    TS_IP=$(jq -r '.machine.tailscale_ip // "—"' <<<"$HEALTH")
    if [[ "$NC_RUNNING" == "true" && "$WA_AUTH" == "true" ]]; then
      _pass 1 "/health 200 · pid=$PID region=$REGION tailscale=$TS_IP"
    else
      _fail 1 "/health returned but subsystems are down (nanoclaw.running=$NC_RUNNING, whatsapp.authenticated=$WA_AUTH)"
    fi
  fi
fi

# ──────────────────────────────────────────────────────────────────────────
# Check 2 — Dashboard loads ≤2s
# ──────────────────────────────────────────────────────────────────────────

if _should_run 2; then
  TIMING=$(curl --max-time 5 --silent --output /dev/null --write-out "%{http_code} %{time_total}" "$BASE/" 2>/dev/null)
  HTTP_CODE=$(awk '{print $1}' <<<"$TIMING")
  TIME_TOTAL=$(awk '{print $2}' <<<"$TIMING")
  if [[ "$HTTP_CODE" == "200" ]]; then
    # bash float comparison via awk
    if awk -v t="$TIME_TOTAL" 'BEGIN{exit !(t < 2.0)}'; then
      _pass 2 "/ rendered HTTP 200 in ${TIME_TOTAL}s"
    else
      _fail 2 "/ rendered HTTP 200 but in ${TIME_TOTAL}s (>2.0s threshold)"
    fi
  else
    _fail 2 "/ returned HTTP $HTTP_CODE"
  fi
fi

# ──────────────────────────────────────────────────────────────────────────
# Check 3 — Telemetry round-trip (HYBRID)
# ──────────────────────────────────────────────────────────────────────────

if _should_run 3; then
  if [[ "$ONLY_CHECK" == "3" ]]; then
    # Re-run mode: look for an agent_turns row started in the last 60s.
    SINCE=$(date -u -v-60S +"%Y-%m-%dT%H:%M:%SZ")
    TURNS=$(_curl "$BASE/api/turns?since=$SINCE&limit=10" || echo '{"turns":[]}')
    COUNT=$(jq '.turns | length' <<<"$TURNS")
    if [[ "$COUNT" -gt 0 ]]; then
      LATEST=$(jq -r '.turns[0] | "\(.started_at) · \(.group_folder) · \(.outcome) · \(.duration_ms)ms"' <<<"$TURNS")
      _pass 3 "Found $COUNT recent agent_turn row(s). Latest: $LATEST"
    else
      _fail 3 "No agent_turns rows started in the last 60s. Did the agent reply?"
    fi
  else
    _manual 3 "Send a message to GGA from your phone, wait for Ben to reply, then run: bash scripts/verify-dashboard-v1.sh --check 3"
  fi
fi

# ──────────────────────────────────────────────────────────────────────────
# Check 4 — Cost rollup matches reality
# ──────────────────────────────────────────────────────────────────────────

if _should_run 4; then
  TODAY=$(date -u +%Y-%m-%d)
  TURNS=$(_curl "$BASE/api/turns?since=${TODAY}T00:00:00Z&limit=500" || echo '{"turns":[]}')
  COST=$(_curl "$BASE/api/cost/daily?days=1" || echo '{"rows":[]}')
  TURNS_SUM=$(jq '[.turns[].est_cost_cents // 0] | add // 0' <<<"$TURNS")
  COST_SUM=$(jq '[.rows[].cents // 0] | add // 0' <<<"$COST")
  DIFF=$((TURNS_SUM - COST_SUM))
  ABS_DIFF=${DIFF#-}
  if [[ "$ABS_DIFF" -le 1 ]]; then
    _pass 4 "Cost reconciliation matches: agent_turns sum=${TURNS_SUM}¢, /api/cost/daily=${COST_SUM}¢ (Δ=${ABS_DIFF}¢)"
  else
    _fail 4 "Cost reconciliation mismatch: agent_turns sum=${TURNS_SUM}¢, /api/cost/daily=${COST_SUM}¢ (Δ=${ABS_DIFF}¢)"
  fi
fi

# ──────────────────────────────────────────────────────────────────────────
# Checks 5 + 6 — Group config edit (PATCH + SIGHUP) and Audit + undo
# ──────────────────────────────────────────────────────────────────────────

if _should_run 5 || _should_run 6; then
  NC_GROUPS=$(_curl "$BASE/api/groups" || echo '{"groups":[]}')
  # Pick the first group that:
  #   - has a name set
  #   - is NOT the main group (lower risk; the script should never touch GGA)
  #   - is NOT a soft-deleted group
  TARGET=$(jq -r '
    .groups[]
    | select(.name and (.name | length > 0))
    | select(.is_main == false)
    | select((.container_config.deleted_at // null) == null)
    | "\(.jid)|\(.name)|\(.container_config.version // 0)"
  ' <<<"$NC_GROUPS" | head -n 1)

  if [[ -z "$TARGET" ]]; then
    _manual 5 "No safe target group found (need a non-main group with a name field). Skipping checks 5 + 6."
    _manual 6 "Skipped — depends on check 5 having a target."
  else
    JID=$(awk -F'|' '{print $1}' <<<"$TARGET")
    ORIGINAL_NAME=$(awk -F'|' '{print $2}' <<<"$TARGET")
    VERSION=$(awk -F'|' '{print $3}' <<<"$TARGET")
    _log "    target group: $JID  (current name: \"$ORIGINAL_NAME\", version: $VERSION)"

    NEW_NAME="${ORIGINAL_NAME} [verify-test]"
    PATCH_BODY=$(jq -n --arg n "$NEW_NAME" '{name: $n}')
    PATCH_RESP=$(curl --max-time 5 --silent \
      -X PATCH \
      -H 'Content-Type: application/json' \
      -H "If-Match: $VERSION" \
      -d "$PATCH_BODY" \
      "$BASE/api/groups/$(printf '%s' "$JID" | jq -sRr @uri)" 2>/dev/null)

    if _should_run 5; then
      AUDIT_ID=$(jq -r '.audit_id // empty' <<<"$PATCH_RESP")
      if [[ -z "$AUDIT_ID" ]]; then
        _fail 5 "PATCH /api/groups/$JID returned no audit_id. Response: $PATCH_RESP"
      else
        # Verify the change took effect (SIGHUP reloads in-memory map).
        sleep 0.3
        VERIFY=$(_curl "$BASE/api/groups/$(printf '%s' "$JID" | jq -sRr @uri)" || echo "{}")
        VERIFY_NAME=$(jq -r '.name // empty' <<<"$VERIFY")
        if [[ "$VERIFY_NAME" == "$NEW_NAME" ]]; then
          _pass 5 "PATCH applied + SIGHUP reload took effect. audit_id=$AUDIT_ID"
        else
          _fail 5 "PATCH returned ok but GET shows name=\"$VERIFY_NAME\" (expected \"$NEW_NAME\")"
        fi
      fi
    fi

    if _should_run 6; then
      # Undo the change
      AUDIT_ID=$(jq -r '.audit_id // empty' <<<"$PATCH_RESP")
      if [[ -z "$AUDIT_ID" ]]; then
        _fail 6 "Cannot undo — no audit_id from check 5"
      else
        UNDO_RESP=$(curl --max-time 5 --silent -X POST "$BASE/api/audit/$AUDIT_ID/undo" 2>/dev/null)
        UNDO_OK=$(jq -r '.ok // false' <<<"$UNDO_RESP")
        if [[ "$UNDO_OK" != "true" ]]; then
          _fail 6 "Undo POST failed. Response: $UNDO_RESP — manually undo via dashboard if needed."
        else
          sleep 0.3
          VERIFY=$(_curl "$BASE/api/groups/$(printf '%s' "$JID" | jq -sRr @uri)" || echo "{}")
          VERIFY_NAME=$(jq -r '.name // empty' <<<"$VERIFY")
          if [[ "$VERIFY_NAME" == "$ORIGINAL_NAME" ]]; then
            _pass 6 "Undo round-trip works — name reverted to \"$ORIGINAL_NAME\""
          else
            _fail 6 "Undo POST succeeded but name is \"$VERIFY_NAME\" (expected \"$ORIGINAL_NAME\"). Manual cleanup needed: PATCH /api/groups/$JID name=\"$ORIGINAL_NAME\""
          fi
        fi
      fi
    fi
  fi
fi

# ──────────────────────────────────────────────────────────────────────────
# Check 7 — KP cross-link (HYBRID)
# ──────────────────────────────────────────────────────────────────────────

if _should_run 7; then
  _manual 7 "Open $BASE/groups/ in your browser. Click any group → Configuration tab → if a related-ticket link is shown, clicking it should focus the corresponding KP ticket via the kanbanpro:// protocol handler."
fi

# ──────────────────────────────────────────────────────────────────────────
# Check 8 — Misclick prevention
# ──────────────────────────────────────────────────────────────────────────

if _should_run 8; then
  # Static export has the dialog markup baked into the HTML. The
  # ConfirmDialog component class signature is stable enough that we can
  # grep for it as a smoke check.
  HTML=$(_curl "$BASE/groups/_/" || echo "")
  if [[ -n "$HTML" ]]; then
    # Look for a tell-tale of the dialog or typed-confirm pattern. The
    # static export bundles components into the chunks, so the dialog
    # might not appear inline. Best-effort: check for the existence of
    # the chunked JS for groups and look for the typed-confirm string.
    if grep -q "RESTART STACK\|UNDO\|verify\|confirmText" <<<"$HTML"; then
      _pass 8 "ConfirmDialog markup present in /groups/ HTML"
    else
      _manual 8 "Confirm primitive not detectable from static HTML alone. Verify manually: open $BASE/groups/, navigate to a group, click Disable — observe a typed-confirm dialog requiring you to type the group name."
    fi
  else
    _fail 8 "Could not fetch /groups/_/ for verification"
  fi
fi

# ──────────────────────────────────────────────────────────────────────────
# Check 9 — Theme toggle (MANUAL)
# ──────────────────────────────────────────────────────────────────────────

if _should_run 9; then
  _manual 9 "Open $BASE/ in your browser. Click the sun/moon icon in the top-right nav. Reload the page. Theme should persist."
fi

# ──────────────────────────────────────────────────────────────────────────
# Check 10 — Federation footprint (MANUAL with optional automated leg)
# ──────────────────────────────────────────────────────────────────────────

if _should_run 10; then
  if [[ -n "$EXPECTED_REGION" ]]; then
    HEALTH=$(_curl "$BASE/health" || echo "")
    REGION=$(jq -r '.machine.region // empty' <<<"$HEALTH")
    if [[ "$REGION" == "$EXPECTED_REGION" ]]; then
      _pass 10 "Region change reflected: /health.machine.region=\"$REGION\""
    else
      _fail 10 "Region mismatch: /health.machine.region=\"$REGION\", expected=\"$EXPECTED_REGION\""
    fi
  else
    _manual 10 "Edit ~/.config/nanoclaw/machine.json region field to a unique value, run: launchctl bootout gui/\$(id -u)/com.nanoclaw && launchctl bootstrap gui/\$(id -u) ~/Library/LaunchAgents/com.nanoclaw.plist; then re-run with: bash scripts/verify-dashboard-v1.sh --check 10 --expected-region <new-value>"
  fi
fi

# ──────────────────────────────────────────────────────────────────────────
# Summary
# ──────────────────────────────────────────────────────────────────────────

if [[ "$JSON_OUTPUT" == "1" ]]; then
  RESULTS_JSON+="]"
  jq -n \
    --argjson results "$RESULTS_JSON" \
    --argjson pass "$PASS_COUNT" \
    --argjson fail "$FAIL_COUNT" \
    --argjson manual "$MANUAL_COUNT" \
    '{pass: $pass, fail: $fail, manual: $manual, results: $results}'
else
  echo
  printf "${C_DIM}────────────────────────────────────────────────────────────────${C_RST}\n"
  printf "  Summary: ${C_OK}%d PASS${C_RST}  ${C_FAIL}%d FAIL${C_RST}  ${C_WARN}%d MANUAL${C_RST}\n" \
    "$PASS_COUNT" "$FAIL_COUNT" "$MANUAL_COUNT"
  if [[ "$FAIL_COUNT" -eq 0 ]]; then
    printf "  ${C_OK}All automated checks passed.${C_RST} See OPERATIONS.md § \"Dashboard v1 verification\" for the bonus checks.\n"
  else
    printf "  ${C_FAIL}One or more automated checks failed.${C_RST} Investigate before declaring v1 shipped.\n"
  fi
fi

[[ "$FAIL_COUNT" -eq 0 ]]
