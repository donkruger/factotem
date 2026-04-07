---
name: kp-integration
description: KP (Kanban Pro) Electron app integration for NanoClaw. Launch KP, create tickets, move cards, switch views, search, and edit tickets via Playwright browser automation. Use for setup, testing, or troubleshooting KP functionality. Triggers on "kp integration", "kanban pro", "create ticket", "move ticket", "switch view".
---

# KP (Kanban Pro) Integration

Playwright Electron automation for Kanban Pro interactions.

> **Compatibility:** NanoClaw v1.0.0. Directory structure may change in future versions.

## Features

| Action | Tool | Description |
|--------|------|-------------|
| Open Project | `kp_open_project` | Launch KP and open a project folder |
| Create Ticket | `kp_create_ticket` | Create a new ticket in a column |
| Move Ticket | `kp_move_ticket` | Drag a ticket card to another column |
| Open Ticket | `kp_open_ticket` | Click a ticket to open detail panel |
| Update Field | `kp_update_field` | Edit title, description, or tags |
| Switch View | `kp_switch_view` | Switch between Board/List/Table/Calendar/Gantt |
| Search | `kp_search` | Invoke Cmd+K and search for tickets |
| Add Comment | `kp_add_comment` | Add a comment to a ticket |

## Prerequisites

Before using this skill, ensure:

1. **NanoClaw is installed and running** — service active
2. **Dependencies installed**:
   ```bash
   npm ls playwright || npm install playwright
   ```
3. **KP Electron app built** — Playwright needs the compiled `main.js`:
   ```bash
   cd /path/to/kanban-pro && npm run electron:build
   ```
4. **Environment configured** in `.env`:
   ```bash
   KP_ELECTRON_MAIN=/path/to/kanban-pro/dist/electron/electron/main.js
   KP_PROJECT_PATH=/path/to/demo-project
   ```

## Quick Start

```bash
# 1. Test open-project script manually
echo '{"projectPath":"/path/to/demo-project"}' | npx tsx .claude/skills/kp-integration/scripts/open-project.ts

# 2. Test create-ticket
echo '{"projectPath":"/path/to/demo","title":"Test Ticket","columnIndex":0}' | npx tsx .claude/skills/kp-integration/scripts/create-ticket.ts

# 3. Rebuild host and restart service
npm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS
# Linux: systemctl --user restart nanoclaw
```

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `KP_ELECTRON_MAIN` | `/path/to/kanban-pro/dist/electron/electron/main.js` | Path to KP's compiled Electron main.js |
| `KP_APP_PATH` | `/Applications/Kanban Pro.app/Contents/MacOS/Kanban Pro` | Path to KP binary (for CDP mode) |
| `KP_PROJECT_PATH` | (empty) | Default project folder to open on launch |
| `KP_RECORD` | (empty) | Set to `1` to enable Playwright video recording |
| `NANOCLAW_ROOT` | `process.cwd()` | Project root directory |

Set in `.env` file:

```bash
# .env
KP_ELECTRON_MAIN=/path/to/kanban-pro/dist/electron/electron/main.js
KP_PROJECT_PATH=/path/to/demo-project
KP_RECORD=1  # Optional: enable video recording
```

### Configuration File

Edit `lib/config.ts` to modify defaults:

- **Timeouts**: `appLaunch` (15s), `navigation` (10s), `elementWait` (5s), `animationSettle` (600ms)
- **Viewport**: 1440x900 (optimised for demo recordings)
- **Recording**: Playwright built-in `.webm` capture to `data/kp-recordings/`

## Architecture

```
Container (agent)
  └── kp_create_ticket tool (agent.ts)
      └── Writes IPC to /workspace/ipc/tasks/
          │
          │ IPC (file system polling)
          ▼
Host (macOS)
  └── src/ipc.ts → processTaskIpc()
      └── src/skills/kp-handler.ts → handleKpIpc()
          └── spawn subprocess → scripts/create-ticket.ts
              └── Playwright Electron API → KP UI
```

**Key difference from X integration:** KP is a local Electron app, so:
- Uses `_electron.launch()` instead of `chromium.launchPersistentContext`
- No authentication or bot detection evasion needed
- Native dialogs are mocked via `app.evaluate()` (Electron main process)

## Connection Modes

### Mode A: Playwright Launch (Default)

Playwright launches KP as a fresh Electron instance. Best for clean, reproducible demo recordings.

### Mode B: CDP Attach

Attach to an already-running KP instance via Chrome DevTools Protocol. Best for live demos. Requires launching KP with:

```bash
open -a "Kanban Pro" --args --remote-debugging-port=9222
```

**Note:** Mac App Store builds strip debug flags. Use the direct-download `.dmg` build.

## File Structure

```
.claude/skills/kp-integration/
├── SKILL.md              # This file
├── agent.ts              # Container-side MCP tool definitions
├── lib/
│   ├── config.ts         # KP-specific configuration
│   ├── browser.ts        # Electron launch + page utilities
│   └── selectors.ts      # Centralised KP UI selectors
└── scripts/
    ├── open-project.ts   # Launch KP and open a project
    ├── create-ticket.ts  # Create a new ticket via UI
    ├── move-ticket.ts    # Drag a ticket to another column
    ├── open-ticket.ts    # Click ticket to open detail panel
    ├── update-field.ts   # Edit a field in ticket detail
    ├── switch-view.ts    # Switch between views
    ├── search.ts         # Cmd+K search
    └── add-comment.ts    # Add a comment to a ticket

src/skills/
└── kp-handler.ts         # Host-side IPC handler
```

## Integration Points

This skill modifies 2 existing files:

### 1. `src/ipc.ts`

```typescript
// Added import
import { handleKpIpc } from './skills/kp-handler.js';

// In processTaskIpc() default case, before handleXIpc:
const kpHandled = await handleKpIpc(data, sourceGroup, isMain, DATA_DIR);
if (!kpHandled) {
  // ... existing X handler fallthrough
}
```

### 2. `container/agent-runner/src/ipc-mcp-stdio.ts`

KP tools (`kp_open_project`, `kp_create_ticket`, etc.) added after X tools section with their own `waitForKpResult()` helper polling from `kp_results/`.

## Screen Recording

### Option 1: Playwright Built-in (Automated)

Set `KP_RECORD=1` in `.env`. Produces `.webm` files in `data/kp-recordings/`.

### Option 2: macOS Screen Capture (Recommended for Marketing)

Screen-record manually (Cmd+Shift+5 or OBS) while NanoClaw drives KP. Produces highest quality, most natural-looking result for Product Hunt / social content.

## Known Gotchas

| Issue | Solution |
|-------|----------|
| Native dialog can't be automated | Use `app.evaluate()` to mock `dialog.showOpenDialog` |
| CDK drag-drop doesn't respond to `dragTo()` | Use explicit mouse sequence: `hover()` → `mouse.down()` → `mouse.move(steps:10)` → `mouse.up()` |
| KP text is localised (ngx-translate) | Never select by visible text — use component tags, CSS classes, `data-testid` |
| Mac App Store build strips debug flags | Use direct-download `.dmg` build for CDP mode |
| Electron app takes time to bootstrap Angular | Use generous `appLaunch` timeout (15s), wait for `kanban-board` selector |
| Glass animations (~300ms) | Use `animationSettle` timeout (600ms) after view transitions |
| KP auto-saves on blur | After editing, click outside or press Tab before asserting |
| Column IDs are UUIDs | Use column index (`.nth()`) not hardcoded IDs |

## Recommended KP Codebase Change

Add `data-testid` attributes to KP's key interactive elements for reliable automation:

| Element | Suggested `data-testid` |
|---------|------------------------|
| Open Folder button | `landing-open-folder` |
| Add ticket input | `column-add-ticket` |
| Ticket card | `ticket-card` |
| Column container | `board-column` |
| View switcher buttons | `view-switch-{board\|list\|table\|calendar\|gantt}` |
| Search input | `search-input` |
| Ticket title input | `ticket-title` |
| Ticket editor | `ticket-editor` |
| Comment input | `ticket-comment-input` |

## Testing

```bash
# Test individual scripts (pipe JSON to stdin)
echo '{"projectPath":"/path/to/demo"}' | npx tsx .claude/skills/kp-integration/scripts/open-project.ts
echo '{"projectPath":"/path/to/demo","title":"Test","columnIndex":0}' | npx tsx .claude/skills/kp-integration/scripts/create-ticket.ts
echo '{"projectPath":"/path/to/demo","view":"list"}' | npx tsx .claude/skills/kp-integration/scripts/switch-view.ts
echo '{"projectPath":"/path/to/demo","query":"bug","selectFirst":false}' | npx tsx .claude/skills/kp-integration/scripts/search.ts
```

## Deployment Checklist

1. `npm run build` — compile host TypeScript
2. Sync agent-runner cache:
   ```bash
   for dir in data/sessions/*/agent-runner-src; do
     [ -d "$dir" ] && cp container/agent-runner/src/*.ts "$dir/"
   done
   ```
3. `launchctl kickstart -k gui/$(id -u)/com.nanoclaw` — restart service
4. Verify agent can see new `kp_*` tools
