---
name: add-excel-reader
description: Add Excel/CSV spreadsheet reading to NanoClaw agents. Extracts data from .xlsx and .csv files via Python openpyxl. Handles WhatsApp attachments, URLs, and local files.
---

# Add Excel Reader

Adds spreadsheet reading capability to all container agents using Python openpyxl. Excel and CSV files sent as WhatsApp attachments are auto-downloaded to the group workspace.

## Phase 1: Pre-flight

1. Check if `container/skills/excel-reader/excel-reader` exists — skip to Phase 3 if already applied
2. Confirm WhatsApp is installed first (`skill/whatsapp` merged). This skill modifies WhatsApp channel files.

## Phase 2: Apply Code Changes

### Ensure WhatsApp fork remote

```bash
git remote -v
```

If `whatsapp` is missing, add it:

```bash
git remote add whatsapp https://github.com/qwibitai/nanoclaw-whatsapp.git
```

### Merge the skill branch

```bash
git fetch whatsapp skill/excel-reader
git merge whatsapp/skill/excel-reader || {
  git checkout --theirs package-lock.json
  git add package-lock.json
  git merge --continue
}
```

This merges in:
- `container/skills/excel-reader/SKILL.md` (agent-facing documentation)
- `container/skills/excel-reader/excel-reader` (CLI script)
- `python3-openpyxl` in `container/Dockerfile`
- Spreadsheet attachment download in `src/channels/whatsapp.ts`
- Spreadsheet tests in `src/channels/whatsapp.test.ts`

If the merge reports conflicts, resolve them by reading the conflicted files and understanding the intent of both sides.

### Validate

```bash
npm run build
npx vitest run src/channels/whatsapp.test.ts
```

### Rebuild container

```bash
./container/build.sh
```

### Restart service

```bash
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS
# Linux: systemctl --user restart nanoclaw
```

## Phase 3: Verify

### Test spreadsheet extraction

Send an Excel file in any registered WhatsApp chat. The agent should:
1. Download the file to `attachments/`
2. Respond acknowledging the spreadsheet
3. Be able to extract and summarize the data when asked

### Test URL fetching

Ask the agent to read a spreadsheet from a URL. It should use `excel-reader fetch <url>`.

### Check logs if needed

```bash
tail -f logs/nanoclaw.log | grep -i spreadsheet
```

Look for:
- `Downloaded spreadsheet attachment` — successful download
- `Failed to download spreadsheet attachment` — media download issue

## Troubleshooting

### Agent says excel-reader command not found

Container needs rebuilding. Run `./container/build.sh` and restart the service.

### Python or openpyxl not found in container

Verify `python3-openpyxl` is in the Dockerfile's `apt-get install` line. Prune build cache and rebuild:

```bash
docker builder prune -f
./container/build.sh
```

### WhatsApp attachment not detected

Verify the message has `documentMessage` with a recognized mimetype. Supported:
- `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` (.xlsx)
- `application/vnd.ms-excel` (.xls)
- `text/csv` / `application/csv` (.csv)
