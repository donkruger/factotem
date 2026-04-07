---
name: whatsapp-formatting
description: Format messages for WhatsApp using native formatting syntax. Use when responding to WhatsApp channels (folder starts with "whatsapp_" or JID contains @s.whatsapp.net / @g.us).
---

# WhatsApp Message Formatting

When responding to WhatsApp channels, use WhatsApp's native formatting syntax instead of standard Markdown.

## How to detect WhatsApp context

Check your group folder name or workspace path:
- Folder starts with `whatsapp_` (e.g., `whatsapp_main`, `whatsapp_ops`)
- Or check `/workspace/group/` path for `whatsapp_` prefix

## Formatting reference

### Text styles

| Style | Syntax | Notes |
|-------|--------|-------|
| Bold | `*text*` | Single asterisks ONLY. Never `**double**`. |
| Italic | `_text_` | Underscores. Never `*single asterisk*` for italic. |
| Strikethrough | `~text~` | Single tildes. Never `~~double~~`. |
| Code (inline) | `` `code` `` | Single backticks for short snippets |
| Code block | ` ```code``` ` | Triple backticks for multi-line code |

### Structure

| Element | Syntax | Notes |
|---------|--------|-------|
| Bullet list | `- item` | Dash + space at start of line |
| Numbered list | `1. item` | Digit + period + space at start of line |
| Block quote | `> text` | Greater-than + space at start of line |

### Links

Paste URLs directly. WhatsApp auto-links them.
- Never use `[text](url)` — it renders as literal text, not a link.

## What NOT to use

- **NO** `**double asterisks**` for bold (WhatsApp shows literal `*` around the text)
- **NO** `~~double tildes~~` for strikethrough (use single `~`)
- **NO** `[text](url)` links (paste the URL directly)
- **NO** `##` headings (use `*Bold text*` on its own line as a heading)
- **NO** tables (use plain text alignment or code blocks)
- **NO** `---` horizontal rules (use a blank line for separation)
- **NO** nested or indented lists (WhatsApp only supports flat single-level lists)

## Important rules

1. Formatting markers must touch the text — no space inside. `*bold*` works, `* bold *` does not.
2. Bold, italic, and strikethrough cannot span multiple lines. Each line needs its own markers.
3. Inside triple-backtick code blocks, all other formatting is ignored — `*`, `_`, `~` show as literal characters.
4. You can nest bold + italic: `*_bold italic_*`

## Use bold sparingly

Bold is for emphasis, not structure. If every label is bold, nothing stands out.

Instead of:
```
*Reply:* We shipped the fix.
*Log:* Updated T-123 with details.
*Status:* All clear.
```

Prefer structured formatting:
```
> We shipped the fix.

- Log: Updated T-123 with details
- Status: All clear
```

Use `*bold*` for:
- Section titles on their own line
- Key terms, names, dates, or action items that need to stand out
- Urgent labels like `*URGENT:*`

Do NOT use `*bold*` for:
- Every label in a list (the list structure provides enough visual separation)
- Entire sentences or paragraphs
- Content that is already inside a block quote or list

## Example: well-formatted WhatsApp message

```
*Morning Briefing*

> Reddit thread found: "Is there a standard trace format?" — 15K views. Reply drafted and posted.

- Log: Updated T-1774611400000.md with timestamp and action summary
- @Richard confirmed the archived post (1 year old). The replacement is the r/macapps sticky notes dev thread — live and open.

*Hunter task:* consolidated into T-1774782150673 (Task 1 — "Confirm a hunter by April 4"). Open it in KP for the full list.
```

## Example: status update

```
*Ticket update*

1. Shipped auth fix to staging
2. Waiting on DevOps for API access
3. Dashboard widgets — 60% complete

> Next sync: Monday 10am
```

## Quick rules

1. Use `*bold*` not `**bold**` — and use it sparingly
2. Use `- item` for bullet lists, `1. item` for numbered lists
3. Use `> text` for quotes and callouts
4. Use `` `code` `` for inline technical terms
5. Paste URLs directly — no link syntax
6. One blank line between sections for readability
7. Skip headings — use bold text on its own line instead
