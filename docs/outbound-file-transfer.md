# Outbound File Transfer — Implementation Guide

**Status:** design only. No source code has been added yet. This guide is the blueprint for a future implementer (Claude or human) so the design doesn't need to be re-derived.

## Summary

Add an MCP tool `mcp__nanoclaw__send_file` that lets container agents upload files (images, PDFs, CSVs, etc.) back to the WhatsApp group or DM they're operating in. Sibling to the existing `mcp__nanoclaw__send_message` (text-only). WhatsApp only for v1; the `Channel` interface gains an optional `sendFile?()` method so Telegram / Slack / Discord can add their own later without a refactor.

## Motivation

Water Watchers use cases the Ben agent has asked for:

- Grafana dashboard screenshots for pressure graphs.
- CSV exports of resident lookup tables.
- PDF reports to escalate with Ugu.
- Georeferenced images of water issues.
- Ticket summaries as PDF snapshots.

GGA and other groups will follow the same patterns.

## Architecture at a glance

```
┌─ container (agent) ─────────────────────────────────────────────────┐
│                                                                      │
│   agent                                                              │
│     │  MCP call                                                      │
│     ▼                                                                │
│   send_file tool (ipc-mcp-stdio.ts)                                  │
│     │  1. validate: exists · size · mimetype · jid auth              │
│     │  2. stage bytes  →  /workspace/ipc/outbound-files/{uuid}.{ext} │
│     │  3. descriptor   →  /workspace/ipc/messages/{ts}-{id}.json     │
│     │     (descriptor written LAST; it is the poller's trigger)      │
└─────┼────────────────────────────────────────────────────────────────┘
      │  shared mount:  /workspace/ipc  ←→  data/ipc/{groupFolder}
┌─────┼────────────────────────────────────────────────────────────────┐
│ host                                                                 │
│     ▼                                                                │
│   src/ipc.ts poll loop                                               │
│     │  read descriptor · resolve stagedFile · re-check size cap      │
│     │  enforce JID auth (main-only cross-send)                       │
│     ▼                                                                │
│   deps.sendFile(jid, buf, meta)    (src/index.ts)                    │
│     ▼                                                                │
│   channel.sendFile(...)            (src/channels/whatsapp.ts)        │
│     ▼                                                                │
│   sock.sendMessage(jid, { image|document, caption, ... })   (Baileys)│
│     │                                                                │
│     ▼                                                                │
│   on success: delete descriptor + staged file                        │
│   on failure: retry once, then log and LEAVE staged file for triage  │
└──────────────────────────────────────────────────────────────────────┘
```

## MCP tool contract

Register next to `send_message` in `container/agent-runner/src/ipc-mcp-stdio.ts` (existing handler at line 43). Use the same `server.tool(...)` + `zod` style.

```ts
server.tool(
  'send_file',
  `Send a file (image, PDF, CSV, etc.) to the current group or, from the main group, to a DM. Fire-and-forget: the tool returns as soon as the file is staged for upload.`,
  {
    file_path: z.string().describe('Absolute container path, e.g. /tmp/report.pdf or /workspace/group/attachments/graph.png'),
    caption: z.string().optional().describe('Optional caption shown with the file'),
    filename: z.string().optional().describe('Display name for recipients (defaults to basename of file_path)'),
    mime_type: z.string().optional().describe('Explicit MIME type (auto-detected from extension when omitted)'),
    sender: z.string().optional(),
    target_jid: z.string().optional().describe('(Main group only) DM/individual JID to send to instead of the current group'),
  },
  async (args) => { /* see §Container-side */ },
);
```

**Deliberately NOT matching** the original brief's `send_file(to, file_path, filename?)` sketch. Existing convention: `send_message` takes `chatJid` implicitly from the container's `NANOCLAW_CHAT_JID` env var and uses `target_jid` *only* for main-group cross-sends. Mirroring that keeps agent-side muscle memory consistent and keeps the host-side authorization logic in one place.

## Container-side implementation

In the handler, in this exact order. Reject at the first failure — don't do work after.

1. **Resolve filename.** `const fileName = args.filename ?? path.basename(args.file_path);`
2. **Exists & readable.** `fs.statSync(args.file_path)` — throw "file not found" with the path on ENOENT.
3. **Size.** Read `stat.size` and compare against per-category caps. Caps from `process.env.NANOCLAW_MAX_IMAGE_BYTES` / `NANOCLAW_MAX_DOCUMENT_BYTES`, default 100 MB / 16 MB. Error text must include the actual size and the cap — agents fix these without round-tripping.
4. **MIME.** Use `args.mime_type` if supplied; otherwise look up the extension in the inline map below. If unknown, throw — force the agent to pass `mime_type` explicitly rather than silently send `application/octet-stream`.

   ```ts
   const EXT_TO_MIME: Record<string, string> = {
     png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
     webp: 'image/webp', gif: 'image/gif',
     pdf: 'application/pdf',
     csv: 'text/csv',
     xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
     xls: 'application/vnd.ms-excel',
     docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
     doc: 'application/msword',
     txt: 'text/plain', json: 'application/json', md: 'text/markdown',
   };
   ```

5. **JID authorization.** Reuse the exact `isMain` + `isGroupJid` guards already present in the `send_message` handler; `target_jid` is only allowed on main groups and only to non-group JIDs. Throw "Invalid target_jid …" on violation.
6. **Stage the bytes.** Write to `path.join(IPC_DIR, 'outbound-files', `${uuid}.${ext}`)` with the `.tmp → rename` atomic pattern that `writeIpcFile()` already uses (ipc-mcp-stdio.ts:23–35). For large files prefer a streamed copy (`fs.createReadStream(src).pipe(fs.createWriteStream(tmp))` + `await finished()` + `fs.renameSync`).
7. **Write the descriptor.** ONLY after the staged file is at its final name. Use `writeIpcFile(MESSAGES_DIR, descriptor)` so the host sees a complete JSON blob via the same atomic pattern that already drives text sends.
8. **Return.** `{ content: [{ type: 'text', text: \`File queued for upload: ${fileName} (${sizeKB}KB, ${mimetype})\` }] }`. Optimistic — the return does not confirm delivery.

Create the `outbound-files` subdirectory on tool startup the same way `MESSAGES_DIR` is created.

## IPC wire format

Descriptor JSON written to `/workspace/ipc/messages/{ts}-{id}.json`:

```json
{
  "type": "send_file",
  "chatJid": "120363426652898616@g.us",
  "stagedFile": "outbound-files/a1b2c3d4.png",
  "mimetype": "image/png",
  "fileName": "res_pressure_graph.png",
  "caption": "Here's the RES circuit pressure graph for the past 7 days",
  "sender": "Ben",
  "groupFolder": "whatsapp_example",
  "timestamp": "2026-04-22T09:30:14.117Z"
}
```

`stagedFile` is a path *relative* to `/workspace/ipc/` (i.e. relative to `data/ipc/{groupFolder}/` on the host). Never an absolute path — the host resolves it against its own mount root.

**Ordering is load-bearing.** Staged file must be at its final name before the descriptor is written. The host's poller treats the descriptor as the atomic trigger — if it exists, the referenced file is guaranteed to be fully written. Violating this invariant produces half-uploaded files on the recipient device.

## Host-side implementation

### `src/ipc.ts`

Add a new case to the existing `data.type` switch (the `=== 'message'` branch is around line 92). Reuse the same `sourceGroup` context and the same main-group / non-main authorization logic.

```ts
} else if (data.type === 'send_file' && data.chatJid && data.stagedFile) {
  // 1. Authorization — identical guards to the 'message' branch.
  // 2. Resolve: const absPath = path.join(IPC_DIR, sourceGroup, data.stagedFile);
  // 3. fs.statSync(absPath); re-check size against cap (defence-in-depth).
  // 4. const buffer = fs.readFileSync(absPath);
  // 5. await deps.sendFile(data.chatJid, buffer, { mimetype, fileName, caption, model });
  // 6. On success: fs.unlinkSync(absPath); (descriptor deletion is already handled by the poll loop.)
  // 7. On first failure: await deps.sendFile(...) once more; on second failure log and LEAVE the staged file in place for operator triage.
  logger.info({ chatJid, fileName, sizeKB, mimetype, sourceGroup }, 'IPC file sent');
}
```

Defence-in-depth: the host must re-check size against `MAX_IMAGE_BYTES` / `MAX_DOCUMENT_BYTES` from `src/config.ts` rather than trusting the container's validation — the IPC mount is shared, and a compromised or buggy container could stage a too-big file.

### `src/index.ts`

Add `sendFile` to the `deps` object alongside the existing `sendMessage` callback at line 742:

```ts
sendFile: (jid, buffer, metadata) => {
  const channel = findChannel(channels, jid);
  if (!channel) throw new Error(`No channel for JID: ${jid}`);
  if (!channel.sendFile) {
    throw new Error(`Channel ${channel.name} does not support file sending`);
  }
  return channel.sendFile(jid, buffer, metadata);
},
```

Also extend `IpcDeps` in `src/ipc.ts` (near line 15) to carry the new method.

### `src/types.ts`

Extend the `Channel` interface (currently at line 87) with an **optional** method so the non-WhatsApp channels don't need to change:

```ts
sendFile?(
  jid: string,
  data: Buffer,
  metadata: { mimetype: string; fileName?: string; caption?: string; model?: string },
): Promise<void>;
```

### `src/channels/whatsapp.ts`

New method modelled on `sendMessage` (line 420). Routing by MIME prefix:

```ts
async sendFile(
  jid: string,
  data: Buffer,
  metadata: { mimetype: string; fileName?: string; caption?: string; model?: string },
): Promise<void> {
  const modelLabel = metadata.model ? ` (${formatModelName(metadata.model)})` : '';
  const rawCaption = metadata.caption ?? '';
  const caption = ASSISTANT_HAS_OWN_NUMBER
    ? rawCaption
    : `👱🏻‍♂️${ASSISTANT_NAME} here...${modelLabel}\n\n${rawCaption}`.trim();

  const content = metadata.mimetype.startsWith('image/')
    ? { image: data, caption, mimetype: metadata.mimetype }
    : { document: data, mimetype: metadata.mimetype, fileName: metadata.fileName, caption };

  if (!this.connected) {
    this.outgoingFileQueue.push({ jid, content });
    return;
  }
  const sent = await this.sock.sendMessage(jid, content as AnyMessageContent);
  if (sent?.key?.id && sent.message) {
    this.sentMessageCache.set(sent.key.id, sent.message);
  }
}
```

Add a parallel `outgoingFileQueue` alongside the existing text `outgoingQueue`, drained the same way on reconnect. Do NOT merge the two queues into one union-typed queue — keeping them separate avoids a branch on every send and makes the code symmetric with the inbound media path which also treats media as a separate shape.

Import `AnyMessageContent` from `@whiskeysockets/baileys/lib/Types` — the other Baileys symbols (`makeWASocket`, `downloadMediaMessage`, `proto`, etc.) are already imported at the top of the file.

## Config knobs

In `src/config.ts`, following the existing `CONTAINER_TIMEOUT` / `IDLE_TIMEOUT` pattern:

```ts
export const MAX_IMAGE_BYTES = parseInt(
  process.env.NANOCLAW_MAX_IMAGE_BYTES || String(100 * 1024 * 1024), 10,
);
export const MAX_DOCUMENT_BYTES = parseInt(
  process.env.NANOCLAW_MAX_DOCUMENT_BYTES || String(16 * 1024 * 1024), 10,
);
```

The container reads the env vars directly inside the MCP handler — no config.ts import on the container side. Host imports them in `src/ipc.ts` for the defence-in-depth re-check.

## Cleanup

On NanoClaw startup, sweep `data/ipc/*/outbound-files/` for files older than 1 hour and delete them. Piggyback on the existing orphaned-container cleanup (currently invoked from `ensureContainerSystemRunning()` in `src/index.ts`). The 1-hour threshold assumes any real send completes in seconds — anything older is orphaned by a host crash or a Baileys failure that left the staged file behind for triage.

Log the sweep count on startup so it's visible when operators tail `nanoclaw.log`.

## Error semantics

**Agent-visible (container-side MCP tool throws):**

| Failure | Thrown error |
|---|---|
| `file_path` does not exist | `file not found: <path>` |
| File exceeds per-category cap | `file too large: <size> bytes exceeds cap of <cap> bytes for <category>` |
| MIME unsupported and not overridden | `unsupported extension .<ext> — pass mime_type explicitly` |
| `target_jid` on non-main / group-to-group | `target_jid not permitted: <reason>` |

**Host-side (logged, not visible to the agent):**

- Baileys `sendMessage` throws → retry once, then `logger.error` with the Baileys error and leave the staged file in place (operator reads `data/ipc/{groupFolder}/outbound-files/` to triage).
- Descriptor references a `stagedFile` that doesn't exist on disk → log and drop the descriptor (no retry; this state means the container crashed between staging and descriptor-write, which is recoverable by the agent trying again).

**No delivery confirmation in v1.** Send is fire-and-forget from the MCP tool's perspective — the same semantics text sends have today. If richer feedback is wanted later, a parallel `ipc/outbound-status/<id>.json` channel can be added without breaking the wire format.

## Deployment steps

Standard NanoClaw deploy flow. In order:

```bash
cd ~/Documents/NanoClaw/nanoclaw

# 1. Build host TypeScript (picks up src/ipc.ts, src/index.ts, src/types.ts, src/channels/whatsapp.ts, src/config.ts)
npm run build

# 2. Rebuild container image (picks up container/agent-runner/src/ipc-mcp-stdio.ts)
./container/build.sh

# 3. Sync agent-runner cache for every group — caches override the baked-in image code (see nanoclaw/CLAUDE.md)
for dir in data/sessions/*/agent-runner-src; do
  [ -d "$dir" ] && cp container/agent-runner/src/*.ts "$dir/"
done

# 4. Restart NanoClaw so the host loads the new code
launchctl kickstart -k gui/$(id -u)/com.nanoclaw

# 5. Stop any running nanoclaw-* containers so they respawn with the new image + synced cache
docker ps --format '{{.Names}}' | grep '^nanoclaw-' | xargs -r docker stop
```

No plist or OneCLI changes required.

## Verification checklist

Run each in a real WhatsApp group (Water Watchers is the natural candidate) and confirm both the host log event and the recipient's WhatsApp view.

| # | Case | Trigger | Expected host log | Expected on recipient device |
|---|---|---|---|---|
| 1 | Missing file | agent calls `send_file({ file_path: "/tmp/does-not-exist.png" })` | no `IPC file sent` line; nothing staged | nothing arrives; agent sees the thrown error |
| 2 | Oversized file | 200 MB dummy PNG | no `IPC file sent`; tool throws at validation | nothing arrives |
| 3 | Unsupported MIME, no override | `.xyz` file | tool throws | nothing arrives |
| 4 | Happy-path PNG | 200 KB Grafana screenshot | `IPC file sent … mimetype=image/png` | inline image preview with caption prefixed by `👱🏻‍♂️Ben here...` |
| 5 | Happy-path PDF | 3 MB PDF | `… mimetype=application/pdf` | downloadable document with original filename and caption |
| 6 | Happy-path CSV | 30 KB CSV | `… mimetype=text/csv` | downloadable document; opens in Excel/Numbers |
| 7 | Host-retry path | briefly disconnect WhatsApp before send | first attempt logs retry; second attempt succeeds | file arrives with small delay |
| 8 | Main cross-send | GGA agent with `target_jid=<DM JID>` | `IPC file sent jid=<DM JID> sourceGroup=whatsapp_main` | file lands in the DM, not GGA |
| 9 | Non-main attempted cross-send | Water Watchers agent with `target_jid=<other JID>` | validation rejects in container; no IPC activity | nothing arrives |
| 10 | Orphan sweep | leave `data/ipc/*/outbound-files/old.png` dated yesterday, restart | startup log shows the sweep removed 1 stale file | n/a |

The guide has succeeded when an implementer with no prior context can run all ten of these without extra questions.

## Design decisions worth preserving

Non-obvious choices the implementer shouldn't second-guess without a reason:

- **Staged file in IPC mount, not base64 in JSON.** 100 MB file = 133 MB base64 inside a polled JSON payload; wastes memory on both sides and stresses the `writeIpcFile` atomic-write pattern.
- **Descriptor written after the staged file.** The descriptor is the poller's trigger. Reversing the order means the host may start reading a still-writing file.
- **`image/*` → inline preview, everything else → document.** Matches WhatsApp UX users already expect from the app. Rare edge case of "send a PNG as a document to preserve full resolution" is a future `as_document: boolean` flag, not a v1 concern.
- **Caption carries the same `👱🏻‍♂️Ben here…` prefix as text sends.** Consistency; the prefix's `ASSISTANT_HAS_OWN_NUMBER` toggle already controls whether it applies.
- **`Channel.sendFile` is optional.** Telegram / Slack / Discord channels can declare their own when their use case lands; keeps the interface honest about v1's scope.
- **No MCP-tool-level delivery confirmation.** Same semantics as text sends today. Adding confirmation means a back-channel the agent has to poll, which is a layer of complexity the current use cases don't justify.
- **Per-category size caps (100 MB / 16 MB).** Matches the user's stated limits and leaves headroom below WhatsApp's real ceiling. Overridable via env var for the rare case an operator wants to relax them.

## Out of scope for v1

Explicitly not in the first implementation. If any of these come up later, they are separate PRs:

- File send from non-WhatsApp channels. (Interface is forward-compatible; Telegram etc. add their own `sendFile`.)
- Reactions, reply-threading, forwarding-specific semantics.
- Rate limiting / per-group upload-throughput caps.
- Explicit per-send delivery status surfaced back to the agent.
- Automatic image compression / resizing before send. (The inbound path uses `sharp` for resize-on-receive at `src/channels/whatsapp.ts:334–350`; an outbound equivalent is a later refinement.)

## References

Live file paths and line numbers the implementer will work against (verified 2026-04-22):

- `container/agent-runner/src/ipc-mcp-stdio.ts:43` — existing `send_message` tool to pattern-match.
- `container/agent-runner/src/ipc-mcp-stdio.ts:23–35` — `writeIpcFile` atomic-write helper.
- `src/ipc.ts:15` — `IpcDeps` interface to extend.
- `src/ipc.ts:92` — existing `'message'` branch in the type switch.
- `src/index.ts:742` — `deps.sendMessage` callback to sibling.
- `src/types.ts:87` — `Channel` interface to extend with optional `sendFile`.
- `src/channels/whatsapp.ts:420` — existing `sendMessage` method to pattern-match.
- `src/channels/whatsapp.ts:264–350` — inbound media handling (download, save to `attachments/`, inject reference into prompt) — the mirror-image reference for an outbound implementation.
- `src/channels/whatsapp.ts:9` — Baileys imports. Add `AnyMessageContent` from `@whiskeysockets/baileys/lib/Types`.
- `node_modules/@whiskeysockets/baileys/lib/Types/Message.d.ts:98–125` — `AnyMessageContent` shape (image, video, audio, document, sticker variants).
- `node_modules/@whiskeysockets/baileys/lib/Socket/messages-send.d.ts:25` — `sock.sendMessage` return type `proto.WebMessageInfo | undefined` (same shape as inbound).
- `nanoclaw/CLAUDE.md` — "Agent-Runner Source Caching" section, which explains why step 3 of the deploy flow (cache sync) is not optional.
