---
name: claw
description: Install the claw CLI tool — run NanoClaw agent containers from the command line without opening a chat app.
---

# claw — NanoClaw CLI

`claw` is a Python CLI that sends prompts directly to a NanoClaw agent container from the terminal. It reads registered groups from the NanoClaw database, picks up secrets from `.env`, and pipes a JSON payload into a container run — no chat app required.

## What it does

- Send a prompt to any registered group by name, folder, or JID
- Default target is the main group (no `-g` needed for most use)
- Resume a previous session with `-s <session-id>`
- Read prompts from stdin (`--pipe`) for scripting and piping
- List all registered groups with `--list-groups`
- Auto-detects `container` or `docker` runtime (or override with `--runtime`)
- Prints the agent's response to stdout; session ID to stderr
- Verbose mode (`-v`) shows the command, redacted payload, and exit code

## Prerequisites

- Python 3.8 or later
- NanoClaw installed with a built and tagged container image (`nanoclaw-agent:latest`)
- Either `container` (Apple Container, macOS 15+) or `docker` available in `PATH`

## Install

Run this skill from within the NanoClaw directory. The script auto-detects its location, so the symlink always points to the right place.

### 1. Copy the script

```bash
mkdir -p scripts
cp "${CLAUDE_SKILL_DIR}/scripts/claw" scripts/claw
chmod +x scripts/claw
```

### 2. Symlink into PATH

```bash
mkdir -p ~/bin
ln -sf "$(pwd)/scripts/claw" ~/bin/claw
```

Make sure `~/bin` is in `PATH`. Add this to `~/.zshrc` or `~/.bashrc` if needed:

```bash
export PATH="$HOME/bin:$PATH"
```

Then reload the shell:

```bash
source ~/.zshrc   # or ~/.bashrc
```

### 3. Verify

```bash
claw --list-groups
```

You should see registered groups. If NanoClaw isn't running or the database doesn't exist yet, the list will be empty — that's fine.

## Usage Examples

```bash
# Send a prompt to the main group
claw "What's on my calendar today?"

# Send to a specific group by name (fuzzy match)
claw -g "family" "Remind everyone about dinner at 7"

# Send to a group by exact JID
claw -j "120363336345536173@g.us" "Hello"

# Resume a previous session
claw -s abc123 "Continue where we left off"

# Read prompt from stdin
echo "Summarize this" | claw --pipe -g dev

# Pipe a file
cat report.txt | claw --pipe "Summarize this report"

# List all registered groups
claw --list-groups

# Force a specific runtime
claw --runtime docker "Hello"

# Use a custom image tag (e.g. after rebuilding with a new tag)
claw --image nanoclaw-agent:dev "Hello"

# Verbose mode (debug info, secrets redacted)
claw -v "Hello"

# Custom timeout for long-running tasks
claw --timeout 600 "Run the full analysis"
```

## Operator verbs (doctor / status / logs / reset-session)

Beyond sending prompts, `claw` exposes a small diagnostic verb surface for the
headless / SSH operator (inspired by `hermes doctor`). These send no prompt and
reuse NanoClaw's existing probes — they never reimplement them.

```bash
# Full health check. Reuses the setup wizard's own probe (setup/verify.ts) and
# renders it for humans with a "what to do next" hint per problem. Exits 0 when
# healthy, nonzero otherwise (CI/cron-friendly). Works even when the orchestrator
# is down. Covers:
#   service · container runtime · credentials · channels · registered groups ·
#   mount allowlist · Auth (live — real Anthropic probe via set-auth-mode.sh) ·
#   OneCLI gateway reachability · WhatsApp connected (live, not the stale
#   auth-dir heuristic) · model-id validity (catches the claude-X.Y dot-vs-dash
#   typo) · large-session warning (resume-hang risk).
claw doctor

# Quick liveness read from the running orchestrator's /health endpoint
# (port from $NANOCLAW_HTTP_PORT, default 7842): version, uptime, Docker,
# OneCLI, WhatsApp. Friendly "not responding → run claw doctor" if it's down.
claw status

# Recent orchestrator log lines (last ~40); -f to follow. Tails the LIVE log
# (.logs/nanoclaw.out.log since the 2026-06-09 plist; falls back to the legacy
# logs/nanoclaw.log for older installs).
claw logs
claw logs -f
claw logs --setup        # show the setup log (logs/setup.log) instead

# Archive a group's Claude session transcript and clear its pinned session, so
# the next turn starts fresh. The fix for a stuck/oversized session that hangs
# resume (the doctor's "Session size" warning points here). Requires an
# orchestrator restart afterwards — the session map is held in memory.
claw reset-session <group-folder>     # e.g. claw reset-session gga

# List the verbs.
claw help
```

All verbs honour `--no-color` and the `NO_COLOR` env var, and suppress colour when
stdout isn't a TTY. `claw doctor` parses (never modifies) the machine-readable
`VERIFY` block from `setup/verify.ts`, so the wizard's status contract is untouched;
it computes its own verdict (a rejected live-auth, unreachable OneCLI, logged-out
WhatsApp, or invalid model id makes it ✗ even when the narrower wizard gate passes).

> Verbs only trigger when the **first** bare token is exactly `doctor` / `status` /
> `logs` / `reset-session` / `help`. A quoted prompt that merely starts with one of
> those words (`claw "status of the deploy?"`) still goes to the agent as a normal prompt.

## Troubleshooting

### "neither 'container' nor 'docker' found"

Install Docker Desktop or Apple Container (macOS 15+), or pass `--runtime` explicitly.

### "no secrets found in .env"

The script auto-detects your NanoClaw directory and reads `.env` from it. Check that the file exists and contains at least one of: `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`.

### Container times out

The default timeout is 300 seconds. For longer tasks, pass `--timeout 600` (or higher). If the container consistently hangs, check that your `nanoclaw-agent:latest` image is up to date by running `./container/build.sh`.

### "group not found"

Run `claw --list-groups` to see what's registered. Group lookup does a fuzzy partial match on name and folder — if your query matches multiple groups, you'll get an error listing the ambiguous matches.

### Container crashes mid-stream

Containers run with `--rm` so they are automatically removed. If the agent crashes before emitting the output sentinel, `claw` falls back to printing raw stdout. Use `-v` to see what the container produced. Rebuild the image with `./container/build.sh` if crashes are consistent.

### Override the NanoClaw directory

If `claw` can't find your database or `.env`, set the `NANOCLAW_DIR` environment variable:

```bash
export NANOCLAW_DIR=/path/to/your/nanoclaw
```
