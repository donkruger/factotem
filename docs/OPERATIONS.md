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
| Docker CLI hangs (no output) | Docker VM paused by Resource Saver | `killall -9 "Docker Desktop" "com.docker.backend" && open -a Docker` — then verify `UseResourceSaver` is `false` in Docker settings |
| `OneCLI gateway not reachable` | OneCLI compose stack down | `cd ~/.onecli && docker compose up -d` |
| `Not logged in · Please run /login` | No API key reaching container | Start OneCLI gateway, restart NanoClaw |
| `spawn npx ENOENT` / exit 127 | launchd PATH missing Homebrew | Use `process.execPath` not bare `npx` |
| WhatsApp QR code prompt then exit | Auth session expired | Run `/add-whatsapp` in Claude Code |
| Agent responds but message not sent | WhatsApp disconnected mid-run | Check log for "Connection closed", service auto-reconnects |
| `Additional mount REJECTED` in log | Mount allowlist empty or missing the path | Add the host path to `~/.config/nanoclaw/mount-allowlist.json` `allowedRoots`, then restart |
| Agent reports "brain not mounted" | Allowlist was reset during setup/restart | Restore `allowedRoots` from group `container_config` in DB (see Recovery Checklist step 3) |
| Container takes 30+ minutes | Stuck agent or long task | Container auto-kills at `CONTAINER_TIMEOUT` (default 30min) |
| Voice notes show `[Voice Message - transcription unavailable]` | `ffmpeg` or `whisper-cli` not in PATH | Ensure `/opt/homebrew/bin` is in plist PATH, then `launchctl unload` + `load` |
| Voice notes show `[Voice Message - transcription failed]` | Model file missing or corrupt | Verify `data/models/ggml-small.bin` exists (~466MB) |
| `spawn ffmpeg ENOENT` in error log | launchd PATH missing Homebrew | Add `/opt/homebrew/bin` to PATH in `com.nanoclaw.plist`, reload service |

## OneCLI Management

```bash
# List configured secrets
onecli secrets list

# List agents
onecli agents list

# Update a secret (e.g. rotate API key)
onecli secrets update --id <secret-id>

# Check gateway logs
cd ~/.onecli && docker compose logs -f app

# Full restart of OneCLI
cd ~/.onecli && docker compose down && docker compose up -d
```
