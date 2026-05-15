# Multi-Agent Completion Blueprint

Implementation guide for closing the load-bearing gaps the seven-PR
Gemini blueprint left open. Reads as a peer of
[`gemini-blueprint.md`](./gemini-blueprint.md): pre-flight, phases,
acceptance tests, risks, forward-compat ledger, milestone breakdown.

> **Why this exists.** The Gemini blueprint shipped the agent registry,
> the OAI container, the wizard's Provider/Credentials steps, the
> agents-first dashboard, and the ModelSwitchModal. What it didn't
> ship — and what an operator running mixed-provider deployments
> would notice within a day — is the telemetry / cost / channel
> topology that makes multi-agent operationally legible.
> An honest audit (2026-05-14) surfaced three load-bearing bugs, two
> product-design questions, and three cleanup items. This blueprint
> defines how to remediate each, ordered by severity and grouped into
> four ship-ready PRs.

---

## 0. Pre-flight reading

Before opening any PR in this blueprint, read in order:

1. [`PROVIDER_PLAYBOOK.md`](../PROVIDER_PLAYBOOK.md) — the architectural
   contract that the Gemini blueprint operationalised. Sections to
   re-read for this work:
   - § 0 (Taxonomy — agent ownership of providers + memory)
   - § 4.1 (Container contract — `cost_micros` lives in the I/O envelope)
   - § 4.3.2 (Agent-level controls — cost rollup belongs to the agent)
   - § 5.2 (Database schema — agents table, FK shape)
   - § 7.5 (Error classes — already complete, no work here)
   - § 11.3 / 11.4 (Forward-compat for agent swarms + federation — informs
     the per-agent WhatsApp choice in Tier 2)
2. [`gemini-blueprint.md`](./gemini-blueprint.md) — particularly
   § 10 (Risks + gotchas) and § 10.5 (Forward-compatibility ledger),
   which call out the items this blueprint closes.
3. [`gemini-acceptance.md`](./gemini-acceptance.md) — the "explicitly
   deferred" section at the bottom matches the bug list here. After
   this blueprint ships, that section shrinks.

The audit that motivated this blueprint is on this branch as
`docs/audits/2026-05-14-multi-agent-audit.md` — go there for the raw
findings, file paths, and quoted code snippets.

---

## 1. Architecture position

```
                  Gemini blueprint (shipped)
                  ───────────────────────────
                  ✓ agents registry           ── primary entity
                  ✓ providers.json            ── single source of truth
                  ✓ OAI container             ── one image per wire protocol
                  ✓ ProviderStep/CredentialsStep
                  ✓ /agents + /agents/<id> + /errors
                  ✓ ModelSwitchModal three-screen flow
                  ✓ Per-message @trigger dispatch
                  ✓ provider.switch + agent.test_message audit classes

  THIS BLUEPRINT closes three categories of gap on top of that:

  Tier 1 — bugs              (1 PR)  PR 8   "Multi-agent observability"
    1.1 Gemini cost wire-up                Cost surfaces report $0 for Gemini today
    1.2 Responder agent attribution        @Ben in Andy's group credits Andy
    1.3 /persona vs /agents reconciliation Two surfaces contradict each other

  Tier 2 — product decisions (2 PRs) PR 9   "Per-agent WhatsApp pairing"
                                     PR 10  "Per-agent open-DM budgets"
    2.1 Multi-WhatsApp positioning         Decision frame + impl per option
    2.2 Per-agent open-DM budget           Decision frame + impl per option

  Tier 3 — cleanup           (1 PR)  PR 11  "Agent lifecycle + isolation"
    3.1 OneCLI credential cleanup on delete
    3.2 Per-agent concurrency telemetry (no quota yet)
    3.3 Per-agent mount-allowlist scaffold

                  ───────────────────────────
                  After: v1.2.1 — operationally complete multi-agent
```

The four PRs are independent: PR 8 ships before PRs 9–11 because the
bugs are user-facing in v1.2 today. PRs 9 and 10 wait on Tier 2
decisions. PR 11 lands whenever — it's pure cleanup. The sections
below order the work for the PR-8-first path; reorder per Don's call.

### Compatibility with v1.0

Every change in this blueprint is **additive**:

- New columns on existing tables (always nullable, always backfilled
  from the v1.0 default state).
- New optional fields on existing JSON envelopes.
- New endpoints, never replacements (`/api/cost/v2` rather than
  modifying `/api/cost/daily` if breaking shape).
- New audit-log classes, never edits to existing rows.

A v1.0 install upgrading to v1.2.1 must show **zero visible change**
on the Claude path. The bugs being fixed are all multi-provider /
multi-agent specific; the operator running one Claude agent today
should notice nothing different except (a) the persona-page redirect
and (b) the slightly different dashboard cost rollup math (still
correct for them since Claude cost was working).

---

## 2. The remediation matrix

| Concern | Tier | PR | Severity | Files touched | LoC est. |
|---|---|---|---|---|---|
| Gemini cost wire-up | 1 | 8 | Blocker | OAI runner, container-runner, cost.ts, types | ~400 |
| Responder agent_id | 1 | 8 | Blocker | db.ts, index.ts, http/api.ts, dashboard | ~300 |
| Persona/Agents reconcile | 1 | 8 | Bug | dashboard `/persona/`, `/agents/` | ~200 |
| Multi-WhatsApp | 2 | 9 | Decision | channels/whatsapp.ts, state schema, wizard | ~800 |
| Per-agent open-DM budget | 2 | 10 | Decision | open-mode.ts, db.ts, dashboard | ~400 |
| OneCLI cred cleanup | 3 | 11 | Minor | agents.ts (deleteAgent path) | ~100 |
| Per-agent concurrency | 3 | 11 | Forward-compat | group-queue.ts, agent_turns | ~150 |
| Per-agent mount allowlist | 3 | 11 | Forward-compat | mount-security.ts, agents table | ~200 |
| **Total** | | | | | **~2550** |

Smaller and tighter than the Gemini blueprint's ~7000 LoC because most
of this is wire-up of existing primitives rather than new system
shape.

---

## 3. Tier 1 — PR 8: Multi-agent observability

The three bugs an operator running Gemini would notice on day one.
Ship as one PR titled **"Multi-agent observability: cost flow,
responder attribution, persona reconciliation."**

### 3.1 Gemini cost wire-up

#### Problem

Three failures compound to silently bill Gemini turns at $0.00:

1. **OAI runner computes but doesn't emit.** `container/oai/agent-runner/src/index.ts`
   has `computeCostMicros()` (lines 127-137) and `PRICE_TABLE`
   (lines 109-125) with `gemini/gemini-2.5-pro` and
   `gemini/gemini-2.5-flash` rates. The function is called by the
   streaming path's `emitStreamEvent({ type: 'message_stop', ...,
   cost_micros })` and by `finaliseOutput()` (line 304). It writes
   to the `ContainerOutput` envelope's `cost_micros` field.
2. **Orchestrator's ContainerOutput interface omits the field.**
   `src/container-runner.ts` lines 62-90 define `ContainerOutput`
   without `cost_micros`. The parser at line 651-652 drops the
   field on JSON parse — TypeScript's structural typing means the
   raw JSON keeps it, but no code reads it.
3. **`src/cost.ts` has no Gemini rates.** `estimateCostCents` at
   lines 22-48 enumerates only Claude variants. Line 65-66 returns
   `0` when the model string isn't in the table (with the comment
   "better to under-report than to fabricate").

The orchestrator's spawn-result handler at `src/index.ts` lines
622-633 calls `estimateCostCents()` directly with the model string
plus token counts — ignoring any cost the container computed. So
even fixing (1) and (2) alone wouldn't help: the orchestrator does
its own cost math from tokens.

#### Approach

Pick the container's `cost_micros` as the **authoritative value when
present**, fall back to the orchestrator's token-derived estimate
otherwise. The container always knows the provider's actual pricing
(it pulls it from the registry on build); the orchestrator's
estimate is a defence-in-depth for older container images.

```
                   ┌─────────────────────────────┐
                   │  Container OUTPUT envelope   │
                   │  cost_micros: 2730           │ ◄── authoritative
                   └──────────────┬───────────────┘
                                  │
                                  ▼
                   ┌─────────────────────────────┐
                   │ orchestrator parses          │
                   │ out.cost_micros present?     │
                   └───────┬─────────────┬────────┘
                       yes │             │ no (legacy container)
                           ▼             ▼
                  ┌─────────────┐  ┌─────────────────────────┐
                  │ persist     │  │ estimateCostCents(model,│
                  │ as-is, ÷100 │  │  tokens) — uses table   │
                  │ → est_cost_ │  │ falls back to 0 if      │
                  │   cents     │  │ model unknown           │
                  └─────────────┘  └─────────────────────────┘
                           │              │
                           └──────┬───────┘
                                  ▼
                       agent_turns.est_cost_cents
```

#### File-by-file changes

**`container/oai/agent-runner/src/index.ts`** — confirm `cost_micros`
lives in the JSON envelope:

```typescript
// finaliseOutput() — already correct, but verify the assembly:
function finaliseOutput(f: FinaliseInput): ContainerOutput {
  // ...
  return {
    status: 'success',
    result: f.assistantText,
    model: canonicalModelString(),
    usage: {
      input_tokens: f.inputTokens,
      output_tokens: f.outputTokens,
    },
    cost_micros: computeCostMicros(f.inputTokens, f.outputTokens), // ← must be on the object
    // ...
  };
}
```

If the field is dropped during `JSON.stringify(output)` (unlikely),
audit the `ContainerOutput` TS interface in the runner — confirm
`cost_micros?: number` is declared.

**`src/container-runner.ts`** — add `cost_micros` to the orchestrator-
side ContainerOutput interface:

```typescript
export interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  model?: string;
  error?: string;
  usage?: { /* unchanged */ };
  // NEW — container-authoritative cost in micro-USD.
  // Set by nanoclaw-agent-oai; not yet emitted by the legacy
  // nanoclaw-agent (Claude) container — falls through to the
  // orchestrator's estimateCostCents() in that case.
  cost_micros?: number;
  started_at?: string;
  // ... rest unchanged
}
```

**`src/cost.ts`** — add `costCentsFromContainer(output)` helper:

```typescript
/**
 * Prefer the container's cost_micros when present (authoritative —
 * the container reads provider rates from setup/providers.json at
 * build time). Fall back to the orchestrator's token-derived
 * estimate for legacy containers that don't emit it.
 *
 * Always returns an integer in cents, rounded half-up.
 */
export function costCentsFromContainer(
  output: ContainerOutput,
  model: string,
): number {
  if (typeof output.cost_micros === 'number' && output.cost_micros > 0) {
    // Convert micro-USD → cents. 1 cent = 10_000 micros.
    return Math.round(output.cost_micros / 10_000);
  }
  return estimateCostCents(
    model,
    output.usage?.input_tokens,
    output.usage?.output_tokens,
    output.usage?.cache_creation_input_tokens,
    output.usage?.cache_read_input_tokens,
  );
}
```

Also add Gemini rates to `MODEL_COSTS` as a defence-in-depth so
`estimateCostCents` returns non-zero for Gemini turns even when
`cost_micros` is missing:

```typescript
// Costs per million tokens, USD cents.
// Source: https://ai.google.dev/pricing (2026-05).
// Re-verify at every release; expired rates round down to 0.
'gemini/gemini-2.5-pro': {
  input: 125,    // $1.25/M input → 125 cents/M
  output: 500,   // $5.00/M output → 500 cents/M
  cache_creation: 0, // Gemini compat-layer doesn't bill caching
  cache_read: 0,
},
'gemini/gemini-2.5-flash': {
  input: 7.5,    // $0.075/M
  output: 30,    // $0.30/M
  cache_creation: 0,
  cache_read: 0,
},
```

**`src/index.ts`** — switch from `estimateCostCents(...)` to
`costCentsFromContainer(output, model)` at the spawn-result handler.
One-line change.

**`/api/cost/daily`** (`src/http/api.ts`) — verify the SQL groups by
`model` correctly when model strings carry the `<protocol>/<model>`
prefix. Current query uses `GROUP BY agent_turns.model`. No change
needed; the rollup naturally bins Gemini rows separately. Add a
test that confirms a mixed-provider day rolls up correctly.

**Dashboard `dashboard/src/app/cost/`** — the model-string display
already uses the canonical `<protocol>/<model>` form (per PR 4).
Verify the existing chart legends + colour mapping handle non-Claude
strings sensibly. If the legend uses model-name shortening that
strips `gemini/` and renders just `gemini-2.5-pro`, that's fine.

#### Acceptance

- [ ] Run a real Gemini turn against `/api/test-message`. Inspect
      `agent_turns` row: `est_cost_cents` > 0, matches `cost_micros`
      from the OUTPUT envelope (within 1-cent rounding).
- [ ] Same turn on a Claude group: `est_cost_cents` unchanged from
      v1.2 baseline (the fallback path still runs through
      `estimateCostCents`).
- [ ] `/api/cost/daily` includes a row per provider; Gemini row's
      `total_cents` is non-zero.
- [ ] Dashboard `/cost` page shows Gemini in the rollup chart. The
      operator can compare provider spend.
- [ ] Unit test: `costCentsFromContainer(output, model)` returns
      container cost when set, falls back when missing.

### 3.2 Responder agent attribution on `agent_turns`

#### Problem

`agent_turns` schema (db.ts lines 99-131) has `group_folder` but no
`agent_id`. Cost rollups join through `registered_groups.agent_id`,
which is the *assigned* agent — not the *responding* agent. When
the per-message `@Ben` trigger overrides Andy's group, the turn is
inserted with `group_folder = 'andy-family'`; the dashboard credits
Andy.

A second-order consequence: per-agent activity counts (turns/day per
agent) are wrong too. Ben handling 20 messages in Andy's group looks
like Ben did 0 work.

#### Approach

Add a nullable `responder_agent_id` column on `agent_turns`. The
orchestrator's spawn path sets it from `dispatchGroup.agent_id` (the
clone produced by trigger-override). The `/api/agents` cost rollup
prefers `responder_agent_id` when present, falls back to the join
through `registered_groups.agent_id`.

Nullable + backfilled-to-NULL because every v1.0/v1.2 turn already
landed on a group's assigned agent; there's nothing to migrate. New
turns carry the responder. Old turns fall through the existing
join, which is correct for them.

#### File-by-file changes

**`src/db.ts`** — schema migration in `createSchema`:

```sql
-- After the existing agents-related migrations:
ALTER TABLE agent_turns ADD COLUMN responder_agent_id TEXT
  REFERENCES agents(id);
CREATE INDEX idx_agent_turns_responder
  ON agent_turns(responder_agent_id, started_at DESC);
```

Add to the existing inline-ALTER + try/catch block. Same pattern as
PR 1's `agent_id` additions on registered_groups + sessions.

Extend `AgentTurnRow` interface and `insertAgentTurn` to accept
`responder_agent_id?: string | null`.

**`src/index.ts`** — at the agent_turns insert site (currently
around line 622-660), set `responder_agent_id` from `dispatchGroup.agent_id`:

```typescript
insertAgentTurn({
  // ... existing fields
  responder_agent_id: dispatchGroup.agent_id ?? null,
});
```

`dispatchGroup` already carries the resolved agent — that's what PR 4
established. This change just persists the resolution.

**`src/http/api.ts`** — update `/api/agents` cost rollup to prefer
`responder_agent_id`:

```sql
-- Today (PR 4):
SELECT registered_groups.agent_id AS agent_id, SUM(...) AS cents
  FROM agent_turns
  LEFT JOIN registered_groups
    ON registered_groups.folder = agent_turns.group_folder
  WHERE substr(agent_turns.started_at, 1, 10) = ?
  GROUP BY registered_groups.agent_id;

-- After PR 8:
SELECT COALESCE(
    agent_turns.responder_agent_id,
    registered_groups.agent_id
  ) AS agent_id,
  SUM(agent_turns.est_cost_cents) AS cents
  FROM agent_turns
  LEFT JOIN registered_groups
    ON registered_groups.folder = agent_turns.group_folder
  WHERE substr(agent_turns.started_at, 1, 10) = ?
  GROUP BY agent_id;
```

The `COALESCE` ensures old turns (NULL responder) keep their pre-PR-8
attribution; new turns carry the truthful responder.

**`/api/cost/daily`** — same `COALESCE` pattern when callers filter
by agent. Add optional `?agent=<id>` query parameter that bins by
`COALESCE(responder_agent_id, registered_groups.agent_id)`.

**`/api/turns`** — surfaces `responder_agent_id` in the row payload
so the Activity feed can show "answered by @Ben (overrode Andy)"
inline. Dashboard rendering is a small `<Badge>` when `responder !=
group.agent_id`.

**`dashboard/src/lib/nanoclaw.ts`** — extend `Turn` interface with
`responder_agent_id?: string | null`. Update `ActivityRow` to render
the override badge when truthy and != the group's assigned agent.

#### Acceptance

- [ ] Send `@Ben hi` in Andy's group. Inspect `agent_turns` row:
      `responder_agent_id = 'ben'`, `group_folder = 'andy-family'`.
- [ ] `/api/agents` reports the turn under Ben's `cost_today_cents`,
      not Andy's.
- [ ] Activity feed shows the turn with a "via @Ben (Andy's group)"
      hint.
- [ ] Old turns (responder NULL) still attribute to group's agent —
      no regression.
- [ ] Dashboard `/agents/andy` and `/agents/ben` no longer
      double-count.

### 3.3 `/persona` vs `/agents` reconciliation

#### Problem

`/persona` is the v1.0 read-only snapshot: shows global
`ASSISTANT_NAME` + per-group trigger_pattern + copy-pasteable
commands for changing them. `/agents` is the v1.2 first-class
entity: per-agent provider, persona, groups, switch-model action.

Both pages describe "what this deployment runs as." Operators
arriving from external links / search results will hit one or the
other and form contradictory mental models — "Andy is the assistant"
vs. "Andy is one of several agents."

#### Approach

Pick option A unless Don explicitly disagrees:

- **A. Deprecate `/persona`, redirect to `/agents`.** Single source
  of truth. The legacy page becomes a 301 with a one-line
  explainer; the per-agent detail page already shows everything
  `/persona` did (assistant name → agent name; per-group trigger →
  agent's default_trigger and per-group overrides).
- **B. Keep `/persona`, rename it "Identity" and scope to the
  default agent.** Less invasive but creates an axis of
  duplication: which is "the real" agent identity page?
- **C. Merge `/persona` content into `/agents`.** Same outcome as A
  via a different code path. More work, no UX benefit.

Recommended: **A**. The deprecation is operator-visible (one
redirect), the per-agent page already covers every legacy field,
and there's no upstream value in keeping `/persona` alive.

#### File-by-file changes

**`dashboard/src/app/persona/page.tsx`** — replace the existing
component with a redirect:

```typescript
import { redirect } from 'next/navigation';

export default function PersonaPage() {
  // /persona was the v1.0 surface for a single-assistant
  // deployment. Multi-agent (v1.2) made it redundant; the per-agent
  // detail page at /agents/<id> is now the canonical identity view.
  // We redirect rather than 404 because operators have this URL
  // bookmarked, deep-linked from docs, etc.
  redirect('/agents');
}
```

Delete `PersonaView.tsx`.

**`dashboard/src/components/layout/NavLinks.tsx`** — remove the
Persona entry. Already done if anyone notices, but if not:

```diff
 const LINKS = [
   { href: '/agents', label: 'Agents' },
   { href: '/', label: 'Server Health' },
   { href: '/activity', label: 'Activity' },
   { href: '/groups', label: 'Groups' },
-  { href: '/persona', label: 'Persona' },
   { href: '/cost', label: 'Cost' },
   { href: '/alerts', label: 'Alerts' },
   { href: '/errors', label: 'Errors' },
   { href: '/audit', label: 'Audit' },
 ];
```

**`src/http/api.ts`** — `/api/persona` endpoint stays in place
(operators may have integrations against it) but the dashboard no
longer calls it. Add a deprecation comment + plan to remove in v1.3.

**Documentation** — update `docs/ARCHITECTURE.md` and any
`/persona`-referencing README sections.

#### Acceptance

- [ ] Visit `http://localhost:3001/persona` → lands on `/agents` with
      a 307 redirect.
- [ ] Nav bar no longer shows "Persona."
- [ ] `/api/persona` still responds (operator integrations may have
      it).
- [ ] No dashboard component imports from `dashboard/src/app/persona/`.

---

## 4. Tier 2 — PRs 9 & 10: Product decisions

Two questions that change product positioning. **Don decides; this
section gives the framework + the implementation per choice.** Each
question is structured as: the question, the options, the
recommendation, and the implementation plan for the recommended
option.

### 4.1 Per-agent WhatsApp pairing (PR 9)

#### The question

Today: one WhatsApp pairing per deployment; all agents dispatched by
`@<trigger>` in message text. Should agents be able to have their
own WhatsApp numbers, or stay sharing one?

#### The options

**Option A — Shared channel forever.** Status quo. Multi-agent is
purely a trigger-routing feature. Ben is "Andy's twin" on the same
phone number.

| Pros | Cons |
|---|---|
| Zero code change | Operators can't run agents as distinct brand identities |
| Setup remains simple (one QR pair) | Ben's blast radius = Andy's blast radius (same account suspension, same contact list) |
| Forward-compat clean (no schema churn) | Limits the multi-tenant phase (v3) — can't isolate tenants on the channel layer |

**Option B — Optional per-agent pairing.** Operator picks at agent
creation: "use the deployment's main number" or "pair this agent to
a new number." Default to shared; opt-in to separate.

| Pros | Cons |
|---|---|
| Best of both — defaults to current behaviour, lets operators escalate to distinct numbers when needed | Wizard adds a branch ("pair now or share?") in the H.5 add-agent flow |
| Schema is small — one nullable `channel_pairing_id` column on agents | `store/auth/` becomes a directory tree rather than a single account |
| Maps cleanly to multi-tenant v3 | Background WebSocket connection count scales with paired agents (Baileys is per-instance) |

**Option C — Per-agent channels are mandatory.** Every new agent
pairs its own number. The shared-channel model goes away.

| Pros | Cons |
|---|---|
| Cleanest mental model (one agent = one phone number) | Massive UX regression — every agent needs a real WhatsApp number, which an operator may not own |
| Each agent's blast radius is its own | First-time install gets harder (two pair flows for a two-agent deployment) |
| | Per-message `@trigger` dispatch becomes redundant (every agent already has its own number) |

#### Recommendation

**Option B — optional per-agent pairing.** It preserves the simple
default ("everyone shares Andy's number, switch by @trigger") while
unlocking the multi-identity case ("Ben answers on a business number,
Andy answers on personal"). Operationally it scales — Baileys handles
multiple connections fine on a modern Mac, and the operator owns the
constraint on how many numbers they want to pair.

The forward-compat win is the deepest reason: when v3 multi-tenant
ships, each tenant probably gets their own channel pairings;
optional-per-agent in v1.2.1 is the prototype shape.

#### Implementation plan (Option B)

**Phase 9.A — Channel-pairing primitive.** New SQL table
`channel_pairings`:

```sql
CREATE TABLE channel_pairings (
  id              TEXT PRIMARY KEY,        -- e.g. 'whatsapp-andy', 'whatsapp-shared'
  kind            TEXT NOT NULL,           -- 'whatsapp' | 'telegram' | …
  display_name    TEXT NOT NULL,           -- "Andy's personal" | "Shared (default)"
  auth_path       TEXT NOT NULL,           -- 'store/auth/<id>' — Baileys creds.json dir
  is_shared       INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,
  -- Optional metadata for the operator's eyes.
  phone_hint      TEXT,                    -- "+27 82 ..." (no auth value here)
  last_connected_at TEXT
);

-- Backfill: one row called 'whatsapp-shared' for the existing
-- store/auth/ directory. Every existing agent points at it.
ALTER TABLE agents ADD COLUMN channel_pairing_id TEXT
  REFERENCES channel_pairings(id);
```

The migration synthesises one `whatsapp-shared` row from the existing
`store/auth/creds.json` and assigns every agent to it. v1.0 behaviour
is byte-identical after migration.

**Phase 9.B — `WhatsAppChannel` accepts a pairing id.** Refactor
`src/channels/whatsapp.ts` to take a `WhatsAppPairing` argument in
its constructor:

```typescript
interface WhatsAppPairing {
  id: string;            // 'whatsapp-shared' | 'whatsapp-ben'
  authDir: string;       // path to store/auth/<id>/
  displayName: string;
}

export class WhatsAppChannel implements Channel {
  constructor(private pairing: WhatsAppPairing) {
    this.name = `whatsapp:${pairing.id}`;
    // ... uses pairing.authDir for Baileys auth state
  }
}
```

`src/index.ts`'s channel-registration loop reads
`channel_pairings` and instantiates one `WhatsAppChannel` per row.

**Phase 9.C — Inbound routing knows which pairing answered.**
`Channel.ownsJid` already exists; extend the `OnInboundMessage`
callback to pass the channel name. The orchestrator's inbound
handler uses it to scope the dispatched agent: messages on Ben's
pairing default to Ben (regardless of @trigger), with the trigger-
override still applying within Ben's pairing if Don has multiple
agents on the same number.

**Phase 9.D — Wizard's H.5 add-agent branch.** After provider + credentials,
the new agent flow asks:

```
WhatsApp pairing for this agent
─────────────────────────────────────────
○ Use this deployment's shared pairing (recommended)
  Andy and the other agents all answer from this number.
  Operators address agents by @<name> in message text.

○ Pair a new WhatsApp account for this agent
  This agent gets its own phone number. Operators message
  this number directly — no @<trigger> needed inside its
  groups.

[Back]                                  [Continue]
```

If the operator picks "pair new," the wizard runs through the existing
`06-pair-whatsapp` step writing to `store/auth/<new-agent-id>/`. The
`channel_pairings` row is inserted on success.

**Phase 9.E — Dashboard surfaces the pairing.** Per-agent detail
page shows the pairing label + a "re-pair this number" affordance.
The shared-pairing row gets a tiny "Used by Andy + Ben + Echo"
indicator so operators see the topology at a glance.

**Phase 9.F — Multi-pairing concurrency.** Baileys connections are
per-pairing; `MAX_CONCURRENT_CONTAINERS` stays global. Verify on a
3-pairing deployment that connection limits don't compound (no need
to multiply container concurrency by pairing count).

#### Acceptance for Option B

- [ ] v1.0/v1.2 install upgrades — the synthesised
      `whatsapp-shared` pairing carries every existing agent.
      WhatsApp behaviour identical.
- [ ] Operator adds Ben on a shared pairing. `@Ben hi` in any of
      Andy's groups routes to Ben via trigger override. Unchanged
      from v1.2.
- [ ] Operator adds Echo on a *new* pairing. Pairs the phone (QR
      scan). Messages sent directly to Echo's number route to
      Echo — no `@Echo` prefix needed in his own groups.
- [ ] If Echo's pairing disconnects, Andy and Ben on the shared
      pairing keep working.
- [ ] Dashboard `/agents/echo` shows "WhatsApp pairing: Echo's
      number (+27 ...)" and offers a Re-pair button.

#### If Option A is chosen instead

Don closes the door on per-agent identity for v1.2.1. The
recommendation downgrades to: **explicitly document the limitation
in `docs/PROVIDER_PLAYBOOK.md § 0.5 (channel topology)`**: "agents
share one WhatsApp pairing in v1.2.x; per-agent pairing is a v1.3
candidate." No code changes; no PR 9. The constraint just becomes
honest.

#### If Option C is chosen instead

Heavier lift — the per-message trigger system goes away. The
`resolveAgentByTrigger` helper is removed; routing is purely
channel-pairing-driven. The wizard's H.5 add-agent flow forces a new
pairing every time. Don't pick C without a strong commercial reason
— losing trigger routing reduces operator power.

### 4.2 Per-agent open-DM budget (PR 10)

#### The question

Open-DM mode reads its daily cap from the main group's
`container_config.openMode`. When two agents both serve open-DM
traffic, they burn from the same pool. Should the budget be:

- **Per-group** (today) — shared across agents on that group
- **Per-agent** — Ben can have a $5/day cap that Andy doesn't share
- **Both** — group-level cap AND agent-level cap, whichever
  triggers first

#### The options

**A. Status quo — per-group budget.** Two agents on the same
open-DM group share the daily cap. When the cap hits, neither
responds.

**B. Per-agent only.** The budget moves from the open-DM config to
the agent record. Each agent gets one daily cap that applies
wherever it answers.

**C. Both** (recommended). Per-group is the operational floor; per-
agent is the strategic ceiling. If either trips, the agent doesn't
spawn that turn.

#### Recommendation

**Option C — both layers.** Operators think about budget at two
scales:

- **Per group**: "this WhatsApp group can cost me at most $5/day"
  (group-scoped, doesn't care which agent answers)
- **Per agent**: "Ben on Gemini can cost me at most $20/day"
  (agent-scoped, sums across every group Ben serves)

These are independent concerns; an operator might cap a chatty group
hard while still letting their general-purpose agent run wider.

#### Implementation plan (Option C)

**Phase 10.A — Schema additions.** Two new columns:

```sql
-- Per-agent daily cap. Nullable; absent = unbounded.
ALTER TABLE agents ADD COLUMN daily_budget_cents INTEGER;

-- New rollup table for fast lookup. Mirrors open_spend_log but
-- keyed by agent_id rather than implicit-deployment.
CREATE TABLE agent_spend_log (
  date       TEXT NOT NULL,
  agent_id   TEXT NOT NULL,
  cents      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (date, agent_id)
);
```

**Phase 10.B — Cost rollup on every spawn.** `src/index.ts`'s spawn
result handler increments both:

```typescript
// After persisting the turn:
incrementOpenSpend(today, costCents);          // existing group-level
incrementAgentSpend(today, dispatchAgentId, costCents); // NEW
```

**Phase 10.C — Pre-spawn gate.** `src/open-mode.ts` already gates
on `getOpenSpendToday()`. Extend to check the agent cap too:

```typescript
// Pseudocode for the gate:
if (group.containerConfig?.openMode?.enabled) {
  if (openDmSpendToday >= group.openMode.dailyBudgetCents) {
    return { allowed: false, reason: 'group_budget_hit' };
  }
}
if (agent.daily_budget_cents != null) {
  if (agentSpendToday >= agent.daily_budget_cents) {
    return { allowed: false, reason: 'agent_budget_hit' };
  }
}
return { allowed: true };
```

**Phase 10.D — Dashboard surfaces.** Per-agent detail page gains a
**Daily budget** field (`$X.XX cap · $Y.YY spent today` progress
bar). The Cost page rolls up by agent in addition to by model.

**Phase 10.E — Audit log.** New action class `agent.budget.update`
(reversible 5 min, mirroring `group.config.update`).

#### Acceptance for Option C

- [ ] Set Ben's daily cap to $1.00 in the dashboard. Send 100
      Gemini turns in 10 minutes (or scripted). 101st turn does
      NOT spawn; orchestrator's audit log shows
      `error_class = 'quota.over_budget'`.
- [ ] Reset cap to $5.00. Send another 100. Andy keeps responding
      unchanged.
- [ ] /errors page shows the budget hit with Ben's name + Recovery
      action ("Raise Ben's cap").
- [ ] Audit log shows `agent.budget.update` with before/after
      payloads when the operator raises the cap.

---

## 5. Tier 3 — PR 11: Agent lifecycle + isolation

Three small cleanups, shippable together. Low risk, none changes
operator behaviour for v1.0 / v1.2 installs.

### 5.1 OneCLI credential cleanup on agent delete

#### Problem

`deleteAgent` in `src/agents.ts` removes the agent row, cascades the
groups/sessions FKs to the default agent, and emits a log line.
What it doesn't do: remove the agent's OneCLI secret. If Ben uses
`credential_id = 'Gemini'`, deleting Ben leaves the `Gemini` secret
in OneCLI's vault.

Not a security risk (the operator still owns the credential) but
the Models page in a future PR will show Gemini as "configured"
forever. Operators with five archived agents will see a vault full
of credentials they no longer use.

#### Approach

**Don't delete the credential automatically.** Two reasons:

1. A credential is often shared across agents (Andy + Ben might both
   point at the same `Anthropic` secret). Auto-delete on first-agent-
   delete would orphan the second agent.
2. The credential might exist for a future agent the operator hasn't
   created yet. Hard-delete is a one-way door we shouldn't take.

Instead: **garbage-collect-on-demand** with operator confirmation.
After `deleteAgent` succeeds, check whether the deleted agent's
`credential_id` is still referenced by any remaining agent. If not,
the dashboard surfaces a one-line nudge on the Models page:

> The **Gemini** credential is no longer used by any agent. [Remove it →]

The nudge calls a new endpoint that runs `onecli secrets delete
<name>`. Operator stays in control.

#### File-by-file changes

**`src/agents.ts`** — extend `deleteAgent` to return the deleted
agent's `credential_id` (existing code already returns void; switch
to returning a summary object).

**`src/http/api.ts`** — new endpoint:

```
GET  /api/credentials/orphaned   → returns credential_ids in OneCLI
                                    not referenced by any agent
POST /api/credentials/:name/delete → calls onecli secrets delete
```

**Dashboard `/agents`** — small banner when orphaned credentials
exist. Banner is dismissable (per-session) so operators who want to
keep credentials around aren't nagged.

#### Acceptance

- [ ] Create Ben on Gemini → delete Ben → `/api/credentials/orphaned`
      includes `Gemini`.
- [ ] Dashboard `/agents` shows the nudge banner.
- [ ] Click "Remove it" → secret deleted from OneCLI → banner
      disappears.
- [ ] Edge case: two agents share `Anthropic` credential, delete one
      → credential is NOT orphaned; no nudge fires.

### 5.2 Per-agent concurrency telemetry

#### Problem

`MAX_CONCURRENT_CONTAINERS = 5` is global. No visibility into "which
agent uses which slice of the budget." Operators on multi-agent
deployments wonder why Ben occasionally lags — was it Andy holding
the queue? Without telemetry we can't tell, and without telemetry
we can't decide whether per-agent quotas are worth building.

#### Approach

**Don't add quota yet.** Just instrument the existing primitives so
the data lands in `agent_turns` and can be queried. Per-agent quota
is a v1.3 candidate once we know the actual distribution.

Two columns on `agent_turns`:

- `queue_wait_ms`: how long the turn sat in the per-group queue
  before spawning. Tracks contention.
- `concurrent_at_spawn`: how many containers were already running
  when this turn spawned. Tracks ceiling proximity.

Surface both in `/api/turns` and on the Activity feed (collapsed by
default — operators expand a row to see them).

#### File-by-file changes

**`src/db.ts`** — schema:

```sql
ALTER TABLE agent_turns ADD COLUMN queue_wait_ms INTEGER;
ALTER TABLE agent_turns ADD COLUMN concurrent_at_spawn INTEGER;
```

**`src/group-queue.ts`** — record queue-wait at spawn time:

```typescript
async processNext(group, prompt, …): Promise<…> {
  const queuedAt = Date.now();
  await this.acquireSlot();
  const queueWaitMs = Date.now() - queuedAt;
  const concurrent = this.activeCount; // sample at spawn
  // Thread these into the agent_turns insert when the result lands.
}
```

**`/api/turns` + Activity feed** — surface both fields. Tooltip
explains the meaning so operators don't need to know the internals.

**`/api/agents`** — add `p95_queue_wait_ms_today` and
`p95_concurrent_at_spawn_today` rollups so the agents page shows
contention per-agent without operators digging.

#### Acceptance

- [ ] Generate concurrent load (script that spawns 6 turns
      simultaneously). Inspect `agent_turns` rows: the 6th has
      `queue_wait_ms > 0` and `concurrent_at_spawn = 5`.
- [ ] Activity feed shows the wait time on expand.
- [ ] No regression on light load (queue_wait_ms ≈ 0,
      concurrent_at_spawn varies).

### 5.3 Per-agent mount-allowlist scaffold

#### Problem

`mount-allowlist.json` is deployment-scoped. If Don ever wants Ben
to see a narrower file-system surface than Andy (say, Ben is
customer-facing and shouldn't read `/Brain/`), there's no path. The
scaffold for per-agent allowlists doesn't exist.

This is a v3 multi-tenant concern, not a v1.2.1 blocker — but adding
the schema scaffold now costs almost nothing and unblocks the v3
work.

#### Approach

Add optional per-agent override to the allowlist. The orchestrator's
mount-security layer reads both: deployment allowlist (the floor)
intersected with the agent's allowlist (the ceiling), if present.
Absent = use deployment allowlist as-is = current behaviour.

#### File-by-file changes

**`src/db.ts`** — schema:

```sql
-- Per-agent mount allowlist override. JSON-shaped
-- (mirrors MountAllowlist from src/types.ts). NULL = inherit
-- the deployment-wide allowlist.
ALTER TABLE agents ADD COLUMN mount_allowlist_override TEXT;
```

**`src/mount-security.ts`** — new `resolveAllowlistForAgent(agent,
deploymentAllowlist)` helper:

```typescript
export function resolveAllowlistForAgent(
  agent: Agent,
  deploymentAllowlist: MountAllowlist,
): MountAllowlist {
  if (!agent.mount_allowlist_override) return deploymentAllowlist;
  // Intersect: only allowed roots that appear in BOTH lists
  // survive. Per-agent override can be narrower than deployment
  // but never broader.
  return intersectAllowlists(
    deploymentAllowlist,
    JSON.parse(agent.mount_allowlist_override),
  );
}
```

**`src/container-runner.ts`** — call the helper instead of reading
the deployment file directly.

**Dashboard `/agents/<id>`** — Settings tab with the override JSON
editor (raw for now; v3 multi-tenant gets a UI). Surface a warning
if the override is broader than the deployment allowlist (which
would have no effect — intersection rules out broadening).

#### Acceptance

- [ ] Default behaviour (no override): every agent sees the same
      mounts as v1.0. No regression.
- [ ] Set Ben's override to exclude `/Brain/`. Spawn Ben's container.
      `/workspace/extra/brain/` is absent from the container's
      filesystem.
- [ ] Andy's container is unchanged.
- [ ] Override trying to broaden (Ben requests `/Documents/private/`
      not in deployment list) → mount silently dropped + warning
      logged.

---

## 6. Migration safety

Every PR in this blueprint must satisfy three invariants before
merge. The Gemini blueprint established these implicitly; this
blueprint makes them explicit because the surface area is broad
enough that one oversight could break a v1.0 install on upgrade.

### Invariant 1 — v1.0 → v1.2.1 is byte-identical for Claude operators

The most-stressed test: an operator running v1.0 today, pulling
v1.2.1, restarting. They run one Claude agent on one WhatsApp pairing.
They notice nothing different except:

- The `/persona` page redirects to `/agents` (PR 8 § 3.3).
- The Cost page rolls up via the new `COALESCE(responder, group_agent)`
  query (PR 8 § 3.2) — same value for v1.0 turns because the responder
  is NULL → falls through to the group's agent → identical to today.

Every schema change in this blueprint is a nullable column with
`NULL` defaults. No backfill is destructive.

### Invariant 2 — v1.2 → v1.2.1 preserves multi-agent state

An operator who added Ben on Gemini during v1.2 testing keeps Ben
through the upgrade. The migration:

- Reads existing `agent_turns` (no `responder_agent_id`); these turns
  attribute to the group's agent via fallback — same as today.
- Creates the `whatsapp-shared` channel pairing from the existing
  `store/auth/` (PR 9 § 4.1). Every agent gets `channel_pairing_id
  = 'whatsapp-shared'`.
- Doesn't touch any `agents.daily_budget_cents` — NULL = unbounded =
  identical to v1.2 behaviour.

### Invariant 3 — Acceptance suite gates every PR

Each PR in this blueprint extends
[`gemini-acceptance.md`](./gemini-acceptance.md) with its own
sub-section. The full suite runs against a real Gemini key before
tagging v1.2.1. The Gemini blueprint's existing acceptance tests
must all still pass.

---

## 7. Acceptance test matrix

Tiered tests per the same shape as `gemini-acceptance.md`. Each
tier has CI-runnable items (typecheck, unit tests) and Don's-Mac-only
items (real Gemini key, real WhatsApp pairing, real Docker spawns).

### PR 8 — Multi-agent observability

**CI-runnable:**
- [ ] All five packages typecheck clean (orchestrator, dashboard,
      GUI wizard, CLI wizard, OAI runner).
- [ ] Unit test for `costCentsFromContainer(output, model)`:
      returns container value when set, falls back to estimate
      when missing.
- [ ] Unit test for the `COALESCE(responder, group_agent)`
      attribution: a turn with `responder_agent_id = 'ben'` and
      `group.agent_id = 'andy'` aggregates under Ben.
- [ ] Schema migration test: brand-new v1.0 DB → `responder_agent_id`
      column lands, existing rows have NULL.

**On Don's Mac:**
- [ ] Real Gemini turn → `agent_turns.est_cost_cents > 0` matches the
      OAI runner's `cost_micros / 10_000` (within 1-cent rounding).
- [ ] `/api/cost/daily` returns rows binned by `<protocol>/<model>`;
      Gemini's row is non-zero.
- [ ] Dashboard `/cost` chart legend shows Gemini distinct from Claude.
- [ ] `@Ben hi` in Andy's group → activity-feed row has the override
      badge; `/api/agents` attributes the cost to Ben, not Andy.
- [ ] `/persona` 307-redirects to `/agents`.

### PR 9 — Per-agent WhatsApp pairing (Option B)

**CI-runnable:**
- [ ] Schema migration: `channel_pairings` table created, one row
      `whatsapp-shared` synthesised, every existing agent has
      `channel_pairing_id` set.
- [ ] Unit test: `WhatsAppChannel` constructor accepts a
      `WhatsAppPairing`, uses the pairing's `authDir` for Baileys
      auth state.

**On Don's Mac:**
- [ ] v1.2 install upgrade: existing WhatsApp pairing still works.
      Andy responds in his groups.
- [ ] Add Echo on a new pairing via the wizard's H.5 add-agent flow.
      QR-pair Echo's phone. Send a DM to Echo's number → Echo
      responds (no @trigger needed).
- [ ] Disconnect Echo's phone (turn off Wi-Fi). Andy and Ben on the
      shared pairing keep responding.
- [ ] Dashboard `/agents/echo` shows "WhatsApp pairing: Echo's
      number" with the phone hint.

### PR 10 — Per-agent open-DM budget (Option C)

**CI-runnable:**
- [ ] Schema migration: `daily_budget_cents` column on agents,
      `agent_spend_log` table created.
- [ ] Unit test for pre-spawn gate: cap = $1.00, spent = $1.01 →
      gate denies with `agent_budget_hit`.

**On Don's Mac:**
- [ ] Set Ben's daily cap to $0.50 in the dashboard. Send Gemini
      messages until cap hits. 101st turn doesn't spawn; audit log
      records `error_class = 'quota.over_budget'`.
- [ ] Reset cap. Andy keeps responding unchanged throughout.
- [ ] Errors page shows the budget hit with Ben's name + Recovery
      action.
- [ ] Audit log shows `agent.budget.update` audit class on cap raise.

### PR 11 — Lifecycle + isolation

**CI-runnable:**
- [ ] Schema migration: `mount_allowlist_override` column on agents.
- [ ] Unit test: `intersectAllowlists(deployment, override)` —
      override that's a subset of deployment narrows correctly;
      override that adds new roots returns only deployment's set.
- [ ] Unit test: `deleteAgent` returns the deleted agent's
      `credential_id`.

**On Don's Mac:**
- [ ] Create Gemini agent → delete it → orphan-credentials banner
      appears on `/agents`. Click "Remove" → OneCLI vault no longer
      lists Gemini.
- [ ] Set Ben's mount override to exclude `/Brain`. Spawn Ben's
      container. `ls /workspace/extra/` does not include `brain/`.
      Andy's container is unchanged.
- [ ] Generate 6 concurrent turns. Inspect `agent_turns` row 6:
      `queue_wait_ms > 0`, `concurrent_at_spawn = 5`.
- [ ] `/agents` shows the new contention metrics.

---

## 8. Risks + gotchas

### 8.1 PR 8 — Cost double-counting if the migration runs twice

If `costCentsFromContainer` is wired up while old containers
(missing `cost_micros`) are still running, the orchestrator's
fallback `estimateCostCents` path keeps producing values. No
double-count — the conditional in `costCentsFromContainer` picks one
or the other, never both. But: if a partial deploy lands where the
orchestrator is upgraded ahead of the OAI runner, the runner emits
`cost_micros = 0` (PR-7 default) instead of NULL → orchestrator
takes the container's "0" instead of estimating. **Mitigation**:
the helper checks `> 0`, not just `!= null`. The fallback fires for
zero values too.

### 8.2 PR 9 — Multiple pairings + Apple Container

The path-resolution work from PROVIDER_PLAYBOOK § 4.7 assumes one
container runtime per deployment. Multi-pairing doesn't change that.
But: per-pairing Baileys auth state stored in
`store/auth/<pairing_id>/` may exceed the deployment's mount
allowlist if the operator didn't broaden it. **Mitigation**: the
orchestrator's mount config auto-allows `store/auth/*/` recursively,
not just `store/auth/`.

### 8.3 PR 9 — Pairing exhaustion vs operator surprise

If the operator pairs 10 WhatsApp accounts, each one keeps an open
WebSocket. Baileys handles this fine but it's not zero-cost. Per
pair: ~50MB RAM, one WebSocket file descriptor. Cap at 5 pairings
per deployment in v1.2.1 to avoid degenerate cases; bump the cap in
v1.3 once we see actual usage. **Mitigation**: surface the limit in
the wizard's add-pairing step.

### 8.4 PR 10 — Per-agent budget races

Two requests arrive at the same moment. Both pass the pre-spawn
gate. Both burn against the cap. Last-write-wins on
`agent_spend_log`. **Mitigation**: use a SQL `INCR` (atomic
increment via `UPDATE ... SET cents = cents + ?`), not a read-
modify-write. SQLite's WAL mode makes this safe.

### 8.5 PR 11 — Per-agent mount-allowlist + open_dm interaction

PR 1's open-DM mount filter (drops Brain + Global for open_dm
profile, defence-in-depth) runs *after* the per-agent intersection.
Both filters apply. If an operator sets Ben's override to *include*
Brain explicitly, but Ben is on an open-DM group, Brain is still
dropped. **Mitigation**: documented but not enforced — open-DM
operators read the docs.

### 8.6 PR 11 — Concurrency telemetry storage cost

`agent_turns` is the largest table by row count. Two more columns
per row at ~8 bytes each adds ~16 bytes × row count. A heavy user
(10 turns/min, 16h/day) adds ~150KB/day. Negligible. **No
mitigation.**

---

## 9. Forward-compatibility ledger updates

Each PR adds an entry to the playbook's § 11 commitments so future
work doesn't accidentally undo this.

| Commitment | Lands in | Future surface that depends on it |
|---|---|---|
| `responder_agent_id` on every turn | PR 8 § 3.2 | Per-agent cost rollup, multi-agent activity feed, future per-agent quota |
| Cost-from-container > cost-from-estimate priority | PR 8 § 3.1 | New providers ship with accurate cost via the registry; orchestrator doesn't need a release every time a model's pricing changes |
| `channel_pairings` table | PR 9 § 4.1 | Multi-tenant v3 (one tenant = one pairing or many), per-agent identity, channel-scoped audit log |
| `daily_budget_cents` on agents | PR 10 | Per-agent cost ceilings; future per-tenant ceilings (just sum across tenant's agents) |
| `mount_allowlist_override` on agents | PR 11 § 5.3 | Multi-tenant mount isolation; the v1 override is per-agent; v3 extends to per-tenant |
| `queue_wait_ms` + `concurrent_at_spawn` | PR 11 § 5.2 | Per-agent SLO measurement (P95 wait time per agent); future per-agent quota |

---

## 10. Milestone breakdown

Recommended PR cadence — each PR is independently shippable. PR 8
goes first because the three bugs it fixes are user-visible today.

| PR | Scope | Reviewer focus | Estimated work |
|---|---|---|---|
| PR 8 | § 3 — Tier 1 bugs (cost flow, responder attribution, persona reconcile) | Migration safety (NULL backfills), cost accuracy on real Gemini turns, no regression on Claude cost | ~2 days, 1 reviewer |
| PR 9 | § 4.1 — Per-agent WhatsApp pairing (Option B) | Existing-pairing-survives migration, new pairing flow UX, Baileys concurrency under multi-pairing load | ~1 week, 2 reviewers (one for UX, one for channel-layer safety) |
| PR 10 | § 4.2 — Per-agent open-DM budget (Option C) | Cap-race correctness via atomic INCR, dashboard surfacing of dual cap | ~2 days, 1 reviewer |
| PR 11 | § 5 — Tier 3 cleanup (OneCLI gc, concurrency telemetry, mount-allowlist scaffold) | Schema additivity, no regression on default-allowlist behaviour | ~2 days, 1 reviewer |

**Total**: ~2 weeks across four PRs. The path is sequential because
PR 9 introduces channel pairings that PR 10's per-agent budget UI
references (the per-agent detail page surfaces both pairing + budget
in one column). PR 11 is independent and can ship in parallel.

After all four land, v1.2.1 ships. The "deferred" section in
`gemini-acceptance.md` shrinks to:

- The OAI container's `auth.expired_key` distinction (still
  unaddressed because Gemini doesn't surface it).
- End-to-end SSE streaming (the embedded chat surface is the only
  consumer; deferred per the v1.2 deferral).
- The sandboxed-test backend (still stubbed; replacing it requires
  building a `kind = 'sandboxed-test'` throwaway-container spawn
  path that this blueprint doesn't cover).

Those three remain as v1.3 candidates.

---

## 11. References

- [`PROVIDER_PLAYBOOK.md`](../PROVIDER_PLAYBOOK.md) — agent-first
  architecture (the contract this blueprint completes)
- [`gemini-blueprint.md`](./gemini-blueprint.md) — the seven-PR
  series this blueprint extends
- [`gemini-acceptance.md`](./gemini-acceptance.md) — the acceptance
  suite each PR here extends
- [`docs/CHANGE_LOG.md`](../CHANGE_LOG.md) — the consolidated v1.2
  Gemini entry; this blueprint becomes a v1.2.1 entry on merge
- [Apple HIG — Reversible Actions](https://developer.apple.com/design/human-interface-guidelines/feedback)
  — the rule for the OneCLI credential cleanup (don't auto-delete;
  nudge with one-click confirm)
- [Baileys multi-instance docs](https://github.com/WhiskeySockets/Baileys) —
  reference for PR 9's per-pairing concurrency
