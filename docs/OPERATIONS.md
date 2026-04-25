# Operations Runbook

How to start, stop, recover, and troubleshoot a running NanoClaw instance.

---

## Startup Dependency Chain

NanoClaw depends on three services that must start **in this order**:

```
1. Docker Desktop  →  2. OneCLI Gateway  →  3. NanoClaw Service
```

If any layer is missing, the layers above it will fail:

| Missing | Symptom |
|---------|---------|
| Docker | `FATAL: Container runtime failed to start` in error log |
| OneCLI | `OneCLI gateway not reachable — container will have no credentials` in log |
| NanoClaw | No messages processed, no log output |

## Starting Everything

### 1. Docker Desktop

Docker must be running before OneCLI or NanoClaw can start.

```bash
# macOS — open Docker Desktop (starts the daemon)
open -a Docker

# Verify
docker info >/dev/null 2>&1 && echo "Docker OK" || echo "Docker not running"
```

**Required settings** (in `~/Library/Group Containers/group.com.docker/settings-store.json`):

| Setting | Required Value | Why |
|---------|---------------|-----|
| `UseResourceSaver` | `false` | Resource Saver pauses the VM after idle timeout, killing OneCLI containers and leaving the docker CLI hanging indefinitely. NanoClaw needs Docker available 24/7. |
| `AutoPauseTimeoutSeconds` | `0` | Backup: even if Resource Saver is re-enabled, a zero timeout prevents auto-pause. |
| `AutoStart` | `true` | Docker must survive reboots without manual intervention. |

If Docker CLI commands hang (no output, no error), the VM is likely paused. Fix: `killall -9 "Docker Desktop" "com.docker.backend" && open -a Docker`.

### 2. OneCLI Gateway

OneCLI provides credential injection so containers get API keys without ever seeing the raw secrets. It runs as a Docker Compose stack.

```bash
# Start
cd ~/.onecli && docker compose up -d

# Verify
curl -s http://127.0.0.1:10254/ >/dev/null && echo "OneCLI OK" || echo "OneCLI not running"

# Check auth & secrets
onecli auth status
onecli secrets list
```

**Config location:** `~/.onecli/docker-compose.yml`
**Ports:** 10254 (app), 10255 (secondary)
**CLI binary:** `~/.local/bin/onecli`
**Dashboard:** http://127.0.0.1:10254/overview

If OneCLI containers were removed, `docker compose up -d` recreates them. The Postgres data persists in a Docker volume (`onecli_pgdata`), so secrets and agent config survive restarts.

### 3. NanoClaw Service

```bash
# macOS (launchd) — start
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist

# macOS — restart (if already loaded)
launchctl kickstart -k gui/$(id -u)/com.nanoclaw

# macOS — stop
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist

# Linux (systemd)
systemctl --user start nanoclaw
systemctl --user restart nanoclaw
systemctl --user stop nanoclaw

# Development (foreground with hot reload)
cd nanoclaw && npm run dev
```

## Verifying Health

After startup, confirm all three layers:

```bash
# 1. Docker
docker info >/dev/null 2>&1 && echo "✓ Docker"

# 2. OneCLI
curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:10254/ | grep -q 200 && echo "✓ OneCLI"

# 3. NanoClaw process
pgrep -f "dist/index.js" >/dev/null && echo "✓ NanoClaw"

# 4. WhatsApp connected (check log for "Connected to WhatsApp")
grep "Connected to WhatsApp" logs/nanoclaw.log | tail -1

# 5. No credential warnings
grep "OneCLI gateway not reachable" logs/nanoclaw.log | tail -1
# (should show nothing from current session, or only from old PIDs)
```

## Logs

```bash
# Main log (info, warnings, message flow)
tail -f logs/nanoclaw.log

# Error log (fatal errors, container crashes)
tail -f logs/nanoclaw.error.log

# Filter by current process
CURRENT_PID=$(pgrep -f "dist/index.js")
grep "$CURRENT_PID" logs/nanoclaw.log | tail -30

# Container logs (per-invocation)
ls -lt groups/whatsapp_main/logs/container-*.log | head -5
```

## Recovery After Crash or Reboot

### Quick Recovery Checklist

1. **Start Docker Desktop** — open the app or `open -a Docker`
2. **Start OneCLI** — `cd ~/.onecli && docker compose up -d`
3. **Check mount allowlist** — if groups use additional mounts (e.g. the Brain), verify `~/.config/nanoclaw/mount-allowlist.json` has matching `allowedRoots`. An empty or missing allowlist silently blocks all additional mounts. Check logs for `Additional mount REJECTED` after restart.
4. **Restart NanoClaw** — `launchctl kickstart -k gui/$(id -u)/com.nanoclaw`
5. **Verify** — check logs for "Connected to WhatsApp" and no OneCLI warnings

### Orphaned Containers

NanoClaw automatically kills orphaned containers on startup (containers from previous runs). If this fails:

```bash
# List any lingering nanoclaw containers
docker ps -a --filter "name=nanoclaw-" --format "{{.Names}} {{.Status}}"

# Kill them
docker rm -f $(docker ps -a --filter "name=nanoclaw-" -q) 2>/dev/null
```

### WhatsApp Re-authentication

WhatsApp sessions persist in `store/auth/`. If the session expires or is revoked:

```bash
# Check auth status
cat store/auth-status.txt

# If re-auth needed: stop service, run /setup or /add-whatsapp in Claude Code
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
cd nanoclaw && claude
# Then run /add-whatsapp inside Claude Code
```

Signs of auth failure: log shows `WhatsApp authentication required` followed by process exit.

### Database Issues

The SQLite database at `store/messages.db` stores messages, groups, tasks, and session state.

```bash
# Check integrity
sqlite3 store/messages.db "PRAGMA integrity_check;"

# If corrupt, the database can be rebuilt (groups and tasks are re-discovered,
# but message history is lost):
mv store/messages.db store/messages.db.bak
# NanoClaw will create a fresh database on next start
```

### Stale Agent-Runner Cache

After modifying `container/agent-runner/src/`, cached copies override the baked-in container code:

```bash
# Sync all cached copies
for dir in data/sessions/*/agent-runner-src; do
  [ -d "$dir" ] && cp container/agent-runner/src/*.ts "$dir/"
done
```

## Deployment After Code Changes

After modifying NanoClaw source code:

```bash
# 1. Compile TypeScript
npm run build

# 2. Rebuild container image (if container-side code changed)
./container/build.sh

# 3. Sync agent-runner cache (if agent-runner changed)
for dir in data/sessions/*/agent-runner-src; do
  [ -d "$dir" ] && cp container/agent-runner/src/*.ts "$dir/"
done

# 4. Restart service
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

## Common Issues

| Problem | Cause | Fix |
|---------|-------|-----|
| `FATAL: Container runtime failed to start` | Docker not running | Start Docker Desktop |
| Docker CLI hangs (no output) | Docker VM paused by Resource Saver, or VM disk full | `killall -9 "Docker Desktop" "com.docker.backend" && open -a Docker` — then verify `UseResourceSaver` is `false` in Docker settings. If it recurs, check backend log for "no space left on device" and run `docker system prune -a -f` |
| `no space left on device` in Docker backend log | Docker VM disk full from build cache and old images | `docker system prune -a -f` — if Docker won't start, increase `DiskSizeMiB` in Docker settings, start Docker, then prune |
| `OneCLI gateway not reachable` | OneCLI compose stack down | `cd ~/.onecli && docker compose up -d` |
| `Not logged in · Please run /login` | No API key reaching container | Start OneCLI gateway, restart NanoClaw |
| Channel replies are literal API error text (e.g. `Invalid API key`, `UND_ERR_ABORTED`, `credentials exist in OneCLI but this agent does not have access`) | Selective-mode agent lost its secret binding, or a persistent container is caching a prior auth error | Follow "Credential Rotation Runbook" below. If bindings look correct, skip to step 4 (stop non-main containers) |
| `spawn npx ENOENT` / exit 127 | launchd PATH missing Homebrew | Use `process.execPath` not bare `npx` |
| WhatsApp QR code prompt then exit | Auth session expired | Run `/add-whatsapp` in Claude Code |
| Agent responds but message not sent | WhatsApp disconnected mid-run | Check log for "Connection closed", service auto-reconnects |
| `Additional mount REJECTED` in log | Mount allowlist empty or missing the path | Add the host path to `~/.config/nanoclaw/mount-allowlist.json` `allowedRoots`, then restart |
| Agent reports "brain not mounted" | Allowlist was reset during setup/restart | Restore `allowedRoots` from group `container_config` in DB (see Recovery Checklist step 3) |
| Container killed after 30min idle | Idle timeout expired after agent finished | Normal cleanup — see "Container Timeouts" section. Increase `IDLE_TIMEOUT` env var or per-group `containerConfig.timeout` if needed |
| Container killed mid-task | Hard timeout hit while agent was working | Set higher `containerConfig.timeout` for the group — see "Container Timeouts" section |
| Voice notes show `[Voice Message - transcription unavailable]` | `ffmpeg` or `whisper-cli` not in PATH | Ensure `/opt/homebrew/bin` is in plist PATH, then `launchctl unload` + `load` |
| Voice notes show `[Voice Message - transcription failed]` | Model file missing or corrupt | Verify `data/models/ggml-small.bin` exists (~466MB) |
| `spawn ffmpeg ENOENT` in error log | launchd PATH missing Homebrew | Add `/opt/homebrew/bin` to PATH in `com.nanoclaw.plist`, reload service |

## Container Timeouts

Two timeout mechanisms control container lifetime. Both are idle timers that **reset on activity** — a container producing output won't be killed mid-sentence.

### How it works

```
Container spawns
  → hard timeout starts (CONTAINER_TIMEOUT or per-group containerConfig.timeout)
  → agent produces output → timeout resets
  → agent goes quiet for timeoutMs → container killed
```

The effective timeout is: `max(containerConfig.timeout, IDLE_TIMEOUT + 30s)`.

### Configuration

| Setting | Default | Scope | How to set |
|---------|---------|-------|------------|
| `CONTAINER_TIMEOUT` | 30min (1800000ms) | Global | Env var in `com.nanoclaw.plist` |
| `IDLE_TIMEOUT` | 30min (1800000ms) | Global | Env var in `com.nanoclaw.plist` |
| `containerConfig.timeout` | none (falls back to global) | Per-group | `container_config` JSON in `registered_groups` table |

**Per-group example** (set GGA to 2-hour timeout):

```bash
sqlite3 store/messages.db "
  UPDATE registered_groups
  SET container_config = json_set(container_config, '$.timeout', 7200000)
  WHERE name = 'GGA';
"
# Then restart NanoClaw
```

### Understanding timeout logs

Check `groups/{folder}/logs/container-*.log` for timeout details:

- **`Had Streaming Output: true`** — the agent finished its work, then the container sat idle. This is normal cleanup, not a failure. The response was already sent.
- **`Had Streaming Output: false`** — the agent never produced output. This means it was stuck (e.g., waiting for credentials, long tool call, or a crash). This IS a problem — investigate the container's full log.

### Recommendations

- For interactive demo groups: set a high `containerConfig.timeout` (e.g., 2 hours) so containers survive between messages without re-spawning
- For autonomous groups: the default 30min is usually fine since the agent responds and the container is cleaned up
- `IDLE_TIMEOUT` controls how long a container waits for follow-up IPC messages after producing output — increase this if conversations have long gaps between messages

## Agent Model

The Claude model each container uses is selected by the `ANTHROPIC_MODEL` environment variable set on the NanoClaw host process. `src/container-runner.ts` forwards it into each spawned container via `-e`, and `container/agent-runner/src/index.ts` passes it to the Claude Agent SDK's `query({ options: { model } })` call. When the env var is absent, the code defaults to `claude-sonnet-4-6`.

| Setting | Default | Where to set |
|---------|---------|--------------|
| `ANTHROPIC_MODEL` | `claude-sonnet-4-6` (in code) | `EnvironmentVariables` block of `~/Library/LaunchAgents/com.nanoclaw.plist` |

Accepted values include versioned IDs (`claude-haiku-4-5`, `claude-sonnet-4-6`, `claude-opus-4-7`) as well as the short aliases the SDK normalises (`haiku`, `sonnet`, `opus`). Anthropic normalises the exact served version on response; the container log line `Model from init: <exact-id>` is the canonical record of what was actually used.

To change the model:

```bash
# 1. Edit the plist (stop NanoClaw first if you prefer a clean edit)
#    Add or update under <key>EnvironmentVariables</key>:
#      <key>ANTHROPIC_MODEL</key>
#      <string>claude-haiku-4-5</string>

# 2. Reload — kickstart alone does not re-read the plist file.
launchctl bootout gui/$(id -u)/com.nanoclaw
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.nanoclaw.plist

# 3. Stop running containers so they respawn under the new model
docker ps --format '{{.Names}}' | grep '^nanoclaw-' | xargs -r docker stop

# 4. Verify
ps eww $(pgrep -f dist/index.js) | tr ' ' '\n' | grep '^ANTHROPIC_MODEL='
# send a test message, then:
tail ~/Documents/NanoClaw/nanoclaw/groups/<group>/logs/container-*.log | grep 'Model from init'
```

No rebuild required — the env var flows at runtime. Rebuilding (`./container/build.sh` + cache sync) is only necessary when changing the agent-runner's code path for model selection, not the value.

## Docker Health

Docker is the foundation of the stack. When it fails, everything above it (OneCLI, NanoClaw containers) fails silently — NanoClaw stays running but can't process messages.

### Required Docker Desktop Settings

**Settings file:** `~/Library/Group Containers/group.com.docker/settings-store.json`
(Must stop Docker before editing; changes take effect on next launch.)

| Setting | Required Value | Why |
|---------|---------------|-----|
| `UseResourceSaver` | `false` | Prevents VM auto-pause that kills all containers |
| `AutoPauseTimeoutSeconds` | `0` | Backup: prevents pause even if Resource Saver re-enabled |
| `AutoStart` | `true` | Docker survives reboots without manual intervention |
| `DiskSizeMiB` | `81920` (80GB) | Prevents VM disk-full crashes (was 60GB, filled up) |

### Docker Disk Management

The Docker VM has a virtual disk (sparse file at `~/Library/Containers/com.docker.docker/Data/vms/0/data/Docker.raw`). Space is consumed by:

| Consumer | Typical Size | Notes |
|----------|-------------|-------|
| `nanoclaw-agent` image | ~1.7GB | Includes Chromium, Node, Claude Code |
| Build cache | 1–5GB | Grows with each `container/build.sh`, not auto-pruned |
| OneCLI images | ~0.8GB | Postgres + OneCLI app |
| Running containers | ~100KB each | Minimal write layers |

**Monitoring:**

```bash
# Quick disk check
docker system df

# Detailed breakdown
docker system df -v

# Check VM disk actual size on host
du -sh ~/Library/Containers/com.docker.docker/Data/vms/0/data/Docker.raw
```

**Pruning** (safe to run anytime — only removes unused resources):

```bash
# Remove unused images and build cache (keeps running containers and their images)
docker system prune -f

# Nuclear option: remove EVERYTHING not currently running
# (will require re-pulling OneCLI images and rebuilding nanoclaw-agent)
docker system prune -a -f
```

After a nuclear prune, restore with:
```bash
./container/build.sh                        # Rebuild nanoclaw-agent
cd ~/.onecli && docker compose up -d        # Re-pull and start OneCLI
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # Restart NanoClaw
```

### Host Disk Usage

NanoClaw's host-side footprint (~2GB total):

| Path | Size | Notes |
|------|------|-------|
| `data/x-browser-profile/` | ~920MB | Chromium profile for X integration |
| `data/models/` | ~465MB | Whisper transcription model |
| `data/sessions/` | ~136MB | Session state per group |
| `logs/` | ~450MB | Main + error log (unbounded — no rotation) |
| `groups/` | ~39MB | Per-group config, container logs |
| `store/` | ~8MB | SQLite DB, WhatsApp auth |

**Logs** are the only unbounded growth risk on the host side. The main log (`logs/nanoclaw.log`) can reach 24M+ lines. Consider periodic truncation:

```bash
# Truncate main log (preserves last 50K lines)
tail -50000 logs/nanoclaw.log > logs/nanoclaw.log.tmp && mv logs/nanoclaw.log.tmp logs/nanoclaw.log
```

**macOS disk reporting:** `df -h` includes APFS local snapshots (Time Machine) in "used" space. Sudden drops in free space (e.g., 37GB overnight) are typically caused by Time Machine hourly snapshots, not NanoClaw. Check with `tmutil listlocalsnapshots /`. Snapshots auto-thin over time; manual deletion: `sudo tmutil deletelocalsnapshots <date>`.

### Pre-Demo Health Check

Run this before any demo to verify the full stack:

```bash
# 1. Docker engine responsive
docker info --format '{{.ServerVersion}}' && echo "✓ Docker"

# 2. Docker disk headroom (warn if build cache > 3GB)
docker system df

# 3. OneCLI healthy
curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:10254/ | grep -q 200 && echo "✓ OneCLI"

# 4. NanoClaw running
pgrep -f "dist/index.js" >/dev/null && echo "✓ NanoClaw"

# 5. WhatsApp connected
cat store/auth-status.txt

# 6. No credential warnings from current PID
CURRENT_PID=$(pgrep -f "dist/index.js")
grep "$CURRENT_PID.*OneCLI gateway not reachable" logs/nanoclaw.log && echo "⚠ Credential issue" || echo "✓ Credentials OK"

# 7. Container resource pressure
docker stats --no-stream --format "table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.MemPerc}}"

# 8. Host disk
df -h /
```

## OneCLI Management

```bash
# List configured secrets
onecli secrets list

# List agents
onecli agents list

# Update a secret value in place (value-only rotation; cannot change --type)
onecli secrets update --id <secret-id> --value <new>

# Check gateway logs
cd ~/.onecli && docker compose logs -f app

# Full restart of OneCLI
cd ~/.onecli && docker compose down && docker compose up -d
```

### Auth Mode

NanoClaw has two supported auth modes, tracked by a single marker file at `~/.config/nanoclaw/auth-mode` (outside Documents/ — the launchd-spawned watcher cannot traverse TCC-protected folders; see the 2026-04-24 lesson below). `api-key` is the stable long-term state; `oauth-workaround` is retained as a reversible fallback.

| Mode | When to use | What's active |
|------|-------------|---------------|
| `api-key` | OneCLI holds a non-rotating Anthropic API key (`sk-ant-api...`). This is the stable long-term state. | Nothing auth-specific — credential sits in OneCLI, no watchers, no rotation required. |
| `oauth-workaround` | OneCLI holds a rotating subscription OAuth token (`sk-ant-oat01-...`) — typically because the host is authenticated via `claude` CLI and you haven't minted an API key yet. | launchd watcher `com.nanoclaw.oauth-refresh` polls the macOS keychain every 60s and re-pushes fresh tokens into OneCLI. See "Applicable only in oauth-workaround mode" below. |

Check and switch with the toggle script:

```bash
scripts/set-auth-mode.sh status                              # current mode + watcher + live probe
scripts/set-auth-mode.sh api-key --value sk-ant-api...       # rotate OneCLI to the API key, disable watcher, stop containers
scripts/set-auth-mode.sh oauth-workaround                    # re-seed OneCLI from keychain, re-enable watcher
```

The toggle script performs all side effects atomically (marker update, OneCLI secret update, watcher launchd state, container respawn, verification probe). Rollback between modes takes ~5 seconds.

Safety: the watcher (`~/.local/bin/nanoclaw-oauth-refresh.sh`) self-checks the marker at the top of every run and exits silently if the mode is not `oauth-workaround`. This means an accidentally-loaded watcher cannot damage `api-key` mode.

### Per-Group Agent Architecture

NanoClaw uses **per-group OneCLI agents** (see `src/container-runner.ts`):

- The main group (`whatsapp_main`, `isMain=true`) uses the **Default Agent** with `secretMode: "all"` — has access to every secret in OneCLI automatically.
- Every non-main group uses a named agent with `identifier = group.folder.toLowerCase().replace(/_/g, '-')` (folder `whatsapp_example` → agent `whatsapp-example`). These default to `secretMode: "selective"` — only see secrets explicitly bound via `onecli agents set-secrets`.

```bash
onecli agents list                              # list all agents with identifiers, modes, tokens
onecli agents secrets --id <agent-id>           # list secret IDs bound to an agent
```

This asymmetry is the source of most credential-related incidents: a change that works for GGA (Default agent, `mode=all`) may leave every other group broken.

### Anthropic Secret — Known-Working Config

`--type anthropic` does not work in current OneCLI versions (returns `credential_not_found` at the proxy layer). Use `--type generic` with the `x-api-key` header override instead:

```bash
onecli secrets create --name Anthropic --type generic \
  --value 'sk-ant-...' \
  --host-pattern 'api.anthropic.com' \
  --path-pattern '/*' \
  --header-name 'x-api-key' \
  --value-format '{value}'
```

Why this specific shape:

- The container is spawned with `ANTHROPIC_API_KEY=placeholder`, so the SDK sends `x-api-key: placeholder`. OneCLI generic injection with the **same** header name (`x-api-key`) overrides the value, swapping in the real credential.
- `--value-format 'Bearer {value}'` (an older suggestion) does not work — Anthropic evaluates `x-api-key` before `Authorization`, sees the placeholder, and rejects the request before reading the Bearer header. The container then replies with the literal string `Invalid API key · Fix external API key`.
- `--path-pattern '/*'` is required — a `null` pattern does not match `/v1/messages`.

Anthropic accepts subscription OAuth tokens (`sk-ant-oat01-...`) via `x-api-key`, not only API keys. The injection shape above is correct for both.

#### Applicable only in oauth-workaround mode

The rest of this subsection covers the rotating-OAuth-token workaround. It is **only relevant when `~/.config/nanoclaw/auth-mode` is `oauth-workaround`**. In `api-key` mode the caveats and watcher below do not apply and should not be reintroduced — see the "Auth Mode" section above for the toggle.

**Caveat for OAuth tokens:** subscription OAuth tokens rotate silently whenever the local Claude Code CLI refreshes them. The CLI revokes the previous access token on refresh, so every active `claude` session on the same host will invalidate the OneCLI-stored snapshot well before its `expiresAt` — the channel will start replying with literal `Invalid API key · Fix external API key` mid-day with no other state change. If Ben is a long-running service on a host where the CLI is also used interactively, prefer a real API key (`sk-ant-api...`) in OneCLI; OAuth requires manual re-rotation every time the CLI refreshes.

Keychain-sourced rotation one-liner (macOS):
```bash
TOKEN=$(security find-generic-password -s "Claude Code-credentials" -w | jq -r .claudeAiOauth.accessToken)
onecli secrets update --id <anthropic-secret-id> --value "$TOKEN"
# then stop non-main containers (see step 4 of the Credential Rotation Runbook)
```

#### OAuth auto-refresh watcher (temporary — macOS only)

A launchd agent `com.nanoclaw.oauth-refresh` runs every 60 seconds and rotates the OneCLI Anthropic secret under two conditions:

1. **Keychain diff** — the current OAuth token from the macOS keychain differs from the last-pushed value (in `/tmp/nanoclaw-oauth-last-pushed`). Catches local refreshes by the Claude Code CLI.
2. **Active auth probe** — if the keychain hasn't changed, the watcher sends a tiny curl-through-proxy request (1 token max) to Anthropic and checks for `authentication_error`. Catches server-side rejections where the locally-stored token is identical but Anthropic has invalidated it.

On either trigger, the watcher calls `onecli secrets update` and stops all `nanoclaw-*` containers so they respawn with working credentials. This is a **workaround** for the rotation problem above; remove it once the Anthropic secret is switched to a non-rotating API key (`sk-ant-api...`) or OneCLI learns to resolve from the keychain at injection time.

**Observability (since 2026-04-24):** every run emits one status line to stdout (captured by the plist's `StandardOutPath`) and writes it to `/tmp/nanoclaw-oauth-refresh.health`. Status keywords: `ok` (healthy tick, nothing to do), `rotated` (pushed new token), `disarmed` (mode != oauth-workaround), `probe-skipped` (no CA cert or agent token yet), `warn` (non-fatal error with detail). `scripts/set-auth-mode.sh status` reads the health file and shows tick age. The earlier revision (pre-2026-04-24) logged via `/usr/bin/logger` and was silently swallowed by the unified log, hiding a ~2 h Ben outage when the watcher TCC-failed and looked healthy on every external metric.

**Files:**
- Script: `/Users/support/.local/bin/nanoclaw-oauth-refresh.sh`. Must live outside `~/Documents` because launchd-spawned processes cannot traverse TCC-protected folders (`Operation not permitted` on `open()`).
- launchd plist: `~/Library/LaunchAgents/com.nanoclaw.oauth-refresh.plist`.
- Mode marker (read by watcher): `~/.config/nanoclaw/auth-mode`. Also outside Documents/ for the same TCC reason — this moved on 2026-04-24 after the watcher was discovered to have been silently failing since its 2026-04-21 install.
- Cache: `/tmp/nanoclaw-oauth-last-pushed` (holds the last-pushed token so polls are no-ops when nothing has rotated).
- Health file: `/tmp/nanoclaw-oauth-refresh.health` (most-recent status line, mtime = last tick).
- Logs: `nanoclaw/logs/oauth-refresh.log` (append of every status line) and `oauth-refresh.error.log` (should be empty — any content is an unhandled zsh error, investigate).

Preferred inspect/disable path is `scripts/set-auth-mode.sh status` / `scripts/set-auth-mode.sh api-key --value ...`. The raw launchctl commands below are a fallback for direct control:

```bash
launchctl list | grep oauth-refresh                                 # PID/exit status
launchctl kickstart -k gui/$(id -u)/com.nanoclaw.oauth-refresh      # force immediate run
launchctl bootout gui/$(id -u)/com.nanoclaw.oauth-refresh           # stop
rm ~/Library/LaunchAgents/com.nanoclaw.oauth-refresh.plist \
   /Users/support/.local/bin/nanoclaw-oauth-refresh.sh                # fully remove
```

Worst-case window: ~60s between rotation and auto-recovery. A single message sent in that window will still surface the `Invalid API key` error string; the next message after the watcher fires will succeed.

### Credential Rotation Runbook

Follow this end-to-end whenever a secret or agent binding changes. Skipping steps 2 or 4 is the usual cause of the "Ben replies with API error text" incident — see `DEBUG_CHECKLIST.md`.

**Step 1 — Decide update vs. delete+recreate.** `secrets update --id <id> --value <new>` rotates the value in place, preserves `injectionConfig`, and does not disturb agent bindings. `secrets delete` + `secrets create` is only necessary when you need to change `--type` or the injection config. The new secret has a new UUID, so every selective-mode binding must be re-attached (step 2).

**Step 2 — Re-bind selective-mode agents (only after delete+recreate).**

```bash
SECRET_ID=<new-secret-id>
for agent_id in $(onecli agents list | jq -r '.[] | select(.isDefault==false and .secretMode=="selective") | .id'); do
  onecli agents set-secrets --id "$agent_id" --secret-ids "$SECRET_ID"
done
```

`set-secrets` **replaces** the full binding list, it does not append. If any agent needs multiple secrets, collect the existing IDs first and pass the full comma-separated set.

**Step 3 — Verify with a direct curl through the proxy.** This isolates OneCLI from NanoClaw, the agent-runner, the SDK, and WhatsApp:

```bash
CA=$(ls /var/folders/*/*/T/onecli-proxy-ca.pem 2>/dev/null | head -1)
TOKEN=$(onecli agents list | jq -r '.[] | select(.identifier=="whatsapp-example") | .accessToken')

curl -sS -x "http://x:${TOKEN}@localhost:10255" --cacert "$CA" \
  -H 'x-api-key: placeholder' -H 'Content-Type: application/json' -H 'anthropic-version: 2023-06-01' \
  -d '{"model":"claude-sonnet-4-6","max_tokens":10,"messages":[{"role":"user","content":"OK"}]}' \
  https://api.anthropic.com/v1/messages
```

Interpreting the response:

| Response | Meaning |
|----------|---------|
| `{"id":"msg_...","content":...}` | Fully working. |
| `{"type":"error","error":{"type":"rate_limit_error",...}}` | **Auth is working**, just throttled. Count as success. |
| `{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}` | Injection not overriding the placeholder — check `--header-name` and `--value-format`. |
| `{"error":"credential_not_found",...}` | `hostPattern`/`pathPattern` mismatch, or agent not bound to any matching secret. |

Swap the `identifier==` filter to verify other agents. `onecli secrets list` is metadata only — never treat "secret exists" as proof the injection works.

**Step 4 — Stop every non-main persistent container.** Group containers cache SDK session state, including error states from a failed first query. A container that was running before the credential fix will keep piping new messages into a wedged session and forwarding error strings to WhatsApp as replies (the host log reports these as successful sends because the agent-runner treats any output as success):

```bash
docker ps --format '{{.Names}}' | grep '^nanoclaw-' | grep -v whatsapp-main | xargs -r docker stop
```

No NanoClaw host restart is needed — the container-runner spawns a fresh container on the next message and re-applies current OneCLI config. Main-group containers often respawn naturally during testing and mask the problem in other groups, so don't skip this step even if GGA looks healthy.

**Step 5 — Send a real test message in each affected group.** If the reply is still an error string, the fix didn't take — go back to step 3 and re-check the injection for that group's agent token specifically.
