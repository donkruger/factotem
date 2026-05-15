# Gemini Acceptance Tests

The full Phase G acceptance suite from
[`gemini-blueprint.md § 9`](./gemini-blueprint.md). This page is
hand-runnable on a real machine — most tests need Docker and a real
Gemini API key, so they can't run in CI. Mark each box as you go;
the suite gates a Gemini-enabled release.

## Test environments

| Test class | Needs | Where to run |
|---|---|---|
| Unit tests | None | `npm test` in `nanoclaw/` — runs in CI |
| Type checks | None | `npm run typecheck` in each package — runs in CI |
| Container smoke | Docker + real Gemini key | Don's Mac, manual |
| Multi-agent dispatch | Running orchestrator + WhatsApp pair | Don's Mac, manual |
| Dashboard surfaces | Built dashboard + orchestrator | Don's Mac, manual |
| Migration | v1/v2 install + upgrade-in-place | Don's Mac, manual |

## Unit / type / lint tests (CI-runnable)

These run on every PR.

- [x] **Orchestrator typecheck** — `cd nanoclaw && npm run typecheck`
- [x] **Dashboard typecheck** — `cd nanoclaw/dashboard && npx tsc --noEmit`
- [x] **GUI typecheck** — `cd nanoclaw/cli/claw-setup-gui && npm run typecheck`
- [x] **CLI typecheck** — `cd nanoclaw/cli/claw-setup && npx tsc --noEmit`
- [x] **OAI agent-runner typecheck** —
      `cd nanoclaw/container/oai/agent-runner && npx tsc --noEmit`
- [x] **Vitest suite** — `cd nanoclaw && npm test`. 24 agent tests
      (including trigger-dispatch) + 9 trigger-dispatch tests +
      pre-existing 269 baseline tests must all pass.
- [x] **Lint** — `cd nanoclaw && npm run lint`. New PR-1..7 files must
      add zero new errors (warnings on try/catch fallback patterns
      are allowed and intentional).

## Container smoke (Phase A § 3.7)

**Needs**: Docker installed and running on host; a real Gemini API key
from [AI Studio](https://aistudio.google.com/app/apikey); OneCLI
gateway running on localhost:10254 with a `Gemini` secret registered.

- [ ] Build the OAI container:
      `cd nanoclaw/container/oai && ./build.sh`
      Expected: `nanoclaw-agent-oai:latest` tagged.
- [ ] **Batch mode smoke** — write a minimal `in.json`:
      ```json
      {"prompt":"What is 2+2?","groupFolder":"test","chatJid":"test@g.us","isMain":false}
      ```
      Run:
      ```bash
      cat in.json | docker run -i --rm \
        -e MODEL=gemini/gemini-2.5-flash \
        -e PROVIDER_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai \
        -e ONECLI_GATEWAY=http://host.docker.internal:10254 \
        -e ASSISTANT_NAME=Andy \
        -e AGENT_ID=andy \
        -e MEMORY_PATH=agents/andy \
        nanoclaw-agent-oai:latest
      ```
      Expected: stdout contains an `---NANOCLAW_OUTPUT_START---` /
      `_END_` envelope. The JSON inside has `"replyText"` whose content
      includes "4" and `"cost_micros"` > 0.
- [ ] **Tool-use smoke** — extend `in.json` to ask
      `"What time is it in Cape Town?"`. Confirm `out.json` has
      `toolCalls` populated with at least one entry for `get_current_time`.
- [ ] **Streaming mode** — same in.json, add `-e STREAM_MODE=sse`.
      Expected: stdout interleaves `---NANOCLAW_STREAM_START---` /
      `_END_` markers with JSON event lines: `message_start` →
      one-or-more `content_block_delta` → `message_stop` with `tokenUsage`.
- [ ] **Tool-use in streaming** — same as above with a tool prompt.
      Confirm `tool_use_start` and `tool_use_result` events fire
      *while* the tool runs (not just at the end).

## Orchestrator routing (Phase B § 4.3)

**Needs**: orchestrator built and running locally.

- [ ] Existing groups on `anthropic` continue spawning `nanoclaw-agent`
      with identical env (no regression on Claude path). Verify by
      grepping `nanoclaw.log` for the image-name and env-var lines
      after one Claude turn.
- [ ] A new group with `provider: { protocol: 'gemini', model:
      'gemini-2.5-pro', ... }` spawns `nanoclaw-agent-oai`. Same
      grep approach.
- [ ] No raw API key in container env at any time.

## OneCLI configuration (Phase C § 5.3)

- [ ] `setup/providers.json` lists both `anthropic` and `gemini`
      entries.
- [ ] `onecli secrets list` shows both `Anthropic` and `Gemini` after
      a clean setup pass.

## Wizard (Phase D § 6.6)

**Needs**: a fresh clone or `~/.config/nanoclaw/setup-state.json`
removed.

- [ ] Run `npm run claw-setup` (or launch the GUI wizard). After
      env-check, the new **Provider** step shows Anthropic + Gemini
      cards.
- [ ] Pick Gemini, enter an invalid key (e.g. `"AIzaTooShort"`), click
      **Test connection**. Expected error copy: *"That key didn't
      authenticate. Common causes: typo, key revoked, project
      deleted."*
- [ ] Enter the real key, click **Test connection**. Expected toast:
      *"Connected to Google Gemini — found N models. Defaulting to
      gemini-2.5-pro."* and auto-advance to Mounts after 800ms.
- [ ] After the run, `~/.config/nanoclaw/setup-state.json` contains
      `provider_default.protocol === 'gemini'` and
      `agents[is_default].provider.protocol === 'gemini'`.
- [ ] CLI wizard run `npm run claw-setup -- --profile=solo` shows the
      same picker.

## Dashboard (Phase E)

**Needs**: built dashboard at `http://localhost:3001`.

### Agents page (E.1, H.4)

- [ ] `/agents` renders. One card per agent. Each card shows name,
      default-badge for the default agent, provider chip, default
      trigger, active groups, today's cost.
- [ ] Single-agent operators see one card + a hint about adding a
      second.

### Per-agent detail (H.4)

- [ ] Click an agent card → lands on `/agents/<id>`.
- [ ] Page renders header, persona block (when set), groups table,
      and the recent-errors mini-panel (24h window).
- [ ] **Switch model** primary CTA visible.

### ModelSwitchModal (E.4)

- [ ] Click **Switch model** → modal opens on Screen A.
- [ ] Pick a different provider → click **Show diff →** → Screen B
      renders capability matrix side-by-side. Differences highlighted
      with `← gained` / `← lost` markers.
- [ ] Capability-loss banners fire when prompt caching or computer
      use are lost.
- [ ] Click **Send a test message first** → Screen C. Type a prompt,
      click **Send test**. Stub reply renders (PR 7 leaves the
      real-spawn backend deferred; the stub-reply notice surfaces
      this).
- [ ] Click **Switch →** → modal closes → post-switch banner appears
      on the detail page.
- [ ] Next inbound message in any of the agent's groups spawns the
      new provider's container (grep `nanoclaw.log` for the spawn
      env).
- [ ] Audit log shows `provider.switch` entry with before/after
      provider snapshots.

### Per-group provider chip (E.1)

- [ ] `/groups` table shows the Agent column with each group's
      assigned agent name.
- [ ] Model column shows `<protocol>/<model>` from the joined
      provider rather than the legacy `container_config.model`.
- [ ] A group with `container_config.provider` set shows a `◆`
      override marker next to its model.

### Errors page (E.5)

- [ ] `/errors` reachable from nav.
- [ ] Empty state when no errors: *"Nothing's gone wrong — yet."*
- [ ] An auth.invalid_key error renders the "Authentication failed"
      diagnosis with the Open Anthropic / Open Google Gemini key
      dashboard primary CTA.
- [ ] Transient classes (rate-limit, container.crash) show the
      "Transient" pill.

## Multi-agent dispatch (Phase H.3)

**Needs**: two agents registered (Andy on Claude, Ben on Gemini),
WhatsApp paired.

- [ ] Send `@Andy hi` in Andy's group. Andy responds via Claude
      container.
- [ ] Send `@Ben hi` in the same group. Ben responds via Gemini
      container. Log line: *"Per-message agent trigger overrode the
      group's assigned agent: groupAgent=andy, triggeredAgent=ben"*.
- [ ] Send `@SomeoneElse hi`. No agent responds (trigger doesn't
      match any registered agent).
- [ ] Send `"hey, did @Ben reply yet?"` — Andy responds (mid-message
      mention shouldn't dispatch).

## Migration (Phase H.1, § 10)

**Needs**: a copy of a v1 or v2 `~/.config/nanoclaw/setup-state.json`
and the matching `store/messages.db`.

- [ ] Place the v1 state file at the canonical path. Start the
      orchestrator.
- [ ] On first startup, the `agents` table gets created. A single
      default agent appears with `id` slugified from `assistantName`,
      `provider.protocol = 'anthropic'`.
- [ ] All `registered_groups.agent_id` and `sessions.agent_id`
      rows are backfilled to the default agent's id.
- [ ] State file is rewritten to v3 with `agents`,
      `default_agent_id`, and the legacy `assistantName` +
      `provider_default` mirrors.
- [ ] Restart the orchestrator. Existing WhatsApp groups still
      respond identically (no behaviour change for the operator).

## Free-tier rate-limit handling

**Needs**: a Gemini free-tier key + a group on `gemini-2.5-flash`.

- [ ] Send 16 messages within one minute. The 16th hits Gemini's
      `RESOURCE_EXHAUSTED` (15 RPM cap on flash).
- [ ] Container's `out.json` carries `error_class:
      'quota.rate_limited'`, doesn't crash.
- [ ] `/errors` page shows the "Rate-limited" diagnosis with the
      "Switch this agent's model" primary CTA + Transient pill.

## UX-copy review

- [ ] Read every visible string in the wizard's Provider and
      Credentials steps, the dashboard's Agents / Errors / ModelSwitch
      surfaces, and the operator-facing `gemini.md`. Run against
      [`PROVIDER_PLAYBOOK.md § 8`](../PROVIDER_PLAYBOOK.md#8-operator-language-guide).
- [ ] Confirm: no "tool use" → "can use tools". No "credential" →
      "API key". No "orchestrator" → "NanoClaw" in operator-facing
      copy. No raw error class strings visible as primary content
      (must be in mono / supporting metadata only).
- [ ] Reviewer signs off before tagging the release.

---

## Carry-over from PR 5/6 — explicitly deferred

- **Sandbox-test backend** — `POST /api/agents/:id/sandbox-test` still
  returns a stub reply. The ModelSwitchModal's Screen C surfaces the
  stub notice. A future PR replaces this with a real throwaway-container
  spawn using `sessions.kind = 'sandboxed-test'`.
- **Error-recovery intent dispatch** — the diagnosis page fires
  `error-recovery-intent` custom events. PR 7 wires `switch-model` to
  navigate; the other intents (`raise-budget`, `view-logs`, `reauth`)
  are listened-for but no-ops until their target flows ship.
- ~~**agent_id on agent_turns**~~ — landed in PR 8.2 (2026-05-12).
  Turns now carry `responder_agent_id`. The group-folder join path
  remains as a fallback for legacy rows pre-migration.
- ~~**Queue-wait telemetry**~~ — landed in PR 12 § 3 (v1.2.1-finish).
  `queue_wait_ms` and `concurrent_at_spawn` are populated from the
  per-group queue's `pendingSince` field, surfaced on the dashboard
  `ActivityRow` detail panel, and `/health.docker.max_concurrent`
  exposes the orchestrator's cap.
- ~~**Wizard add-agent pairing branch**~~ — landed in PR 12 § 2
  (v1.2.1-finish). New agents created via the wizard's "Add another
  agent" path now route through `PairingChoiceStep`: pick the
  deployment's shared WhatsApp account (default) or pair a new number
  through the same QR flow, parameterised per pairing via
  `NANOCLAW_AUTH_DIR` + `NANOCLAW_PAIRING_ID` env vars on the auth
  script.
- ~~**OneCLI credential deletion**~~ — landed in PR 12 § 4
  (v1.2.1-finish). `DELETE /api/credentials/:name` shells out to
  `onecli secrets delete` after a TOCTOU re-check that the credential
  isn't referenced by any agent; the dashboard's
  `OrphanCredentialsBanner` surfaces unused credentials and gates the
  destructive action behind `TypedConfirmModal` (operator types the
  credential name verbatim to confirm).
- **Streaming SSE end-to-end** — the OAI container emits SSE events
  in stream mode (PR 2). The orchestrator forwarding layer + the
  dashboard's progressive renderer don't exist yet; the embedded chat
  surface in the playbook § 11.1 is the first consumer.
