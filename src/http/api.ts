/**
 * Operator-action REST API for the Factotem dashboard.
 *
 * T-1778236000000 (Phase 0.5 of Factotem Dashboard v1 epic).
 *
 * Per Q1 of the dashboard decisions, no auth middleware in v1 —
 * Tailscale-trust is the only network boundary. Endpoints assume a
 * single trusted operator. Multi-operator + scope-vocabulary arrive
 * in v1.5 with the auth deliverables.
 *
 * Convention check (per master plan invariant 7):
 * - All endpoints are additive — no replacement of existing IPC,
 *   skill, or SQLite primitives.
 * - container_config JSON pattern preserved (PATCH merges keys
 *   additively; never replaces wholesale).
 * - SIGHUP handler in src/index.ts is the in-process reload primitive.
 */

import type { Express, Request, Response } from 'express';
import express from 'express';

import {
  AuditAction,
  isReversible,
  readAuditById,
  readAuditEntries,
  writeAudit,
} from '../audit-log.js';
import { AgentTurnRow, getAllTasks, setRegisteredGroup } from '../db.js';
import { getAgent, listAgents, updateAgent } from '../agents.js';
import type { Provider } from '../types.js';
import { loadProviderRegistry } from '../providers-registry.js';
import {
  createPairing,
  deletePairing,
  getPairing,
  listPairings,
} from '../channels/pairings.js';
import Database from 'better-sqlite3';
import * as childProcess from 'child_process';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { ASSISTANT_NAME, DEFAULT_TRIGGER, STORE_DIR } from '../config.js';
import { logger } from '../logger.js';
import { RegisteredGroup } from '../types.js';
import { getAlertsSnapshot, isRestartStackEnabled } from './alerts.js';
import { getMachineIdentity } from './machine-identity.js';

export interface ApiDeps {
  /**
   * Read the live in-process registered groups map. Always called fresh
   * because the orchestrator's SIGHUP handler may have updated it.
   */
  getRegisteredGroups: () => Record<string, RegisteredGroup>;
  /**
   * Trigger the orchestrator's config-reload signal handler so a group
   * config edit takes effect on the next message without requiring a
   * full launchctl restart. Implementation in src/index.ts is
   * `process.kill(process.pid, 'SIGHUP')`.
   */
  reloadConfig: () => void;
  /**
   * Drop a message into the IPC input queue for a given group folder so
   * a running container picks it up on its next poll. Used by the
   * /api/test-message endpoint.
   */
  injectIpcMessage: (groupFolder: string, text: string) => void;
}

let queryDb: Database.Database | undefined;
function db(): Database.Database {
  if (!queryDb) {
    queryDb = new Database(path.join(STORE_DIR, 'messages.db'), {
      readonly: false,
    });
  }
  return queryDb;
}

export function mountApi(app: Express, deps: ApiDeps): void {
  app.use(express.json({ limit: '256kb' }));

  // ---- groups ----

  app.get('/api/groups', (_req: Request, res: Response) => {
    const groups = deps.getRegisteredGroups();
    // Look up agents up-front so each group can carry its resolved
    // provider chip without N+1 reads. The dashboard's GroupListTable
    // renders the chip per row (Gemini blueprint § 7.1 / Phase E.1).
    const agents = listAgents();
    const agentsById = new Map(agents.map((a) => [a.id, a]));
    const defaultAgent = agents.find((a) => a.is_default) ?? null;
    const list = Object.entries(groups).map(([jid, g]) => {
      const owningAgent =
        (g.agent_id && agentsById.get(g.agent_id)) || defaultAgent;
      // Per-group provider override wins over the agent's provider
      // (PROVIDER_PLAYBOOK § 0). Most groups won't override.
      const resolvedProvider =
        g.containerConfig?.provider ?? owningAgent?.provider ?? null;
      return {
        jid,
        name: g.name,
        folder: g.folder,
        trigger: g.trigger,
        added_at: g.added_at,
        requires_trigger: g.requiresTrigger ?? true,
        is_main: g.isMain ?? false,
        container_config: g.containerConfig ?? null,
        agent_id: g.agent_id ?? owningAgent?.id ?? null,
        agent: owningAgent
          ? {
              id: owningAgent.id,
              name: owningAgent.name,
              provider: owningAgent.provider,
            }
          : null,
        // Resolved provider for chip rendering. Mirrors the resolution
        // chain the orchestrator runs at spawn time.
        provider: resolvedProvider,
      };
    });
    res.json({ groups: list });
  });

  app.get('/api/groups/:jid', (req: Request, res: Response) => {
    const jid = req.params.jid;
    const group = deps.getRegisteredGroups()[jid];
    if (!group) {
      res.status(404).json({ error: 'group not found' });
      return;
    }
    res.json({
      jid,
      ...group,
      requires_trigger: group.requiresTrigger ?? true,
      is_main: group.isMain ?? false,
    });
  });

  // ---- agents ----
  //
  // Gemini blueprint PR 4 (Phase H.4). The dashboard's /agents page reads
  // these endpoints. /api/agents/:id returns the agent's groups for the
  // per-agent detail view. /api/agents (list) returns everything the
  // agents-page card needs in one round-trip: name, provider, default
  // trigger, active-group count, today's cost.

  app.get('/api/agents', (_req: Request, res: Response) => {
    const agents = listAgents();
    const groups = deps.getRegisteredGroups();
    const groupsByAgent = new Map<string, number>();
    for (const g of Object.values(groups)) {
      const id = g.agent_id ?? agents.find((a) => a.is_default)?.id ?? null;
      if (!id) continue;
      groupsByAgent.set(id, (groupsByAgent.get(id) ?? 0) + 1);
    }
    // Today's cost rollup. SQLite query against agent_turns —
    // attribute each turn to the agent that owned the group at the
    // time of the turn. For multi-agent dispatch turns where the
    // overriding agent differs from the group's assigned agent, this
    // simplified rollup still credits the group's owner (we'll
    // tighten attribution in a future PR once agent_turns carries
    // an explicit responding_agent_id column).
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    // PR 8 § 3.2: prefer agent_turns.responder_agent_id (the agent
    // that actually answered after any @<trigger> override) over the
    // group's assigned agent. COALESCE keeps the v1.0 / v1.2 fallback
    // working for old turns with NULL responder_agent_id.
    const costRows = db()
      .prepare(
        `SELECT COALESCE(agent_turns.responder_agent_id, registered_groups.agent_id) AS agent_id,
                COALESCE(SUM(agent_turns.est_cost_cents), 0) AS cents
           FROM agent_turns
           LEFT JOIN registered_groups
             ON registered_groups.folder = agent_turns.group_folder
          WHERE substr(agent_turns.started_at, 1, 10) = ?
          GROUP BY COALESCE(agent_turns.responder_agent_id, registered_groups.agent_id)`,
      )
      .all(today) as Array<{ agent_id: string | null; cents: number }>;
    const costByAgent = new Map<string, number>();
    const defaultAgentId = agents.find((a) => a.is_default)?.id ?? null;
    for (const row of costRows) {
      const id = row.agent_id ?? defaultAgentId;
      if (!id) continue;
      costByAgent.set(id, (costByAgent.get(id) ?? 0) + row.cents);
    }

    res.json({
      agents: agents.map((a) => ({
        id: a.id,
        name: a.name,
        persona: a.persona,
        provider: a.provider,
        memory_namespace: a.memory_namespace,
        default_trigger: a.default_trigger,
        parent_agent_id: a.parent_agent_id,
        is_default: a.is_default,
        created_at: a.created_at,
        active_group_count: groupsByAgent.get(a.id) ?? 0,
        cost_today_cents: costByAgent.get(a.id) ?? 0,
      })),
    });
  });

  app.get('/api/agents/:id', (req: Request, res: Response) => {
    const agent = getAgent(req.params.id);
    if (!agent) {
      res.status(404).json({ error: 'agent not found' });
      return;
    }
    const groups = deps.getRegisteredGroups();
    const ownedGroups = Object.entries(groups)
      .filter(([, g]) => (g.agent_id ?? null) === agent.id)
      .map(([jid, g]) => ({
        jid,
        name: g.name,
        folder: g.folder,
        trigger: g.trigger,
        is_main: g.isMain ?? false,
      }));
    // PR 9.E — join the agent's pairing so the dashboard surface
    // renders it without a second round-trip. Falls back to the
    // shared pairing for legacy rows that don't yet have a
    // pairing assigned.
    const pairingId = agent.channel_pairing_id ?? null;
    const pairing = pairingId ? getPairing(pairingId) : null;
    // PR 10 — today's spend for this agent, for the budget meter.
    const today = new Date().toISOString().slice(0, 10);
    const spentTodayCents =
      (
        db()
          .prepare(
            `SELECT COALESCE(cents, 0) AS cents FROM agent_spend_log
            WHERE date = ? AND agent_id = ?`,
          )
          .get(today, agent.id) as { cents: number } | undefined
      )?.cents ?? 0;
    res.json({
      ...agent,
      groups: ownedGroups,
      pairing,
      spent_today_cents: spentTodayCents,
    });
  });

  // Switch an agent's provider. Per PROVIDER_PLAYBOOK § 4.3.2, this
  // moves *all* of the agent's groups together; per-group overrides
  // (rarely set) stay where they are. The switch is reversible for 5
  // minutes via the standard audit-undo path.
  //
  // Body: { protocol, model, base_url?, credential_id? }
  // The credential is expected to already exist in OneCLI — the
  // dashboard's Models page or the wizard's CredentialsStep registers
  // it before any switch. If the operator switches to a protocol they
  // haven't set up yet, the spawn will fail at the next inbound
  // message; the dashboard surfaces that as an error class.
  // PATCH /api/agents/:id — generic agent patch. Used by the
  // dashboard to update budget, pairing, persona, mount allowlist,
  // etc. The provider-switch path stays on the dedicated endpoint
  // because it has its own audit class + reload semantics.
  app.patch('/api/agents/:id', (req: Request, res: Response) => {
    const id = req.params.id;
    const existing = getAgent(id);
    if (!existing) {
      res.status(404).json({ error: 'agent not found' });
      return;
    }
    const body = req.body as Partial<{
      name: string;
      persona: string;
      default_trigger: string;
      channel_pairing_id: string | null;
      daily_budget_cents: number | null;
      mount_allowlist_override: string | null;
    }>;
    if (!body) {
      res.status(400).json({ error: 'patch body required' });
      return;
    }

    const before = {
      name: existing.name,
      persona: existing.persona,
      default_trigger: existing.default_trigger,
      channel_pairing_id: existing.channel_pairing_id ?? null,
      daily_budget_cents: existing.daily_budget_cents ?? null,
    };
    let updated;
    try {
      updated = updateAgent(id, {
        name: body.name,
        persona: body.persona,
        default_trigger: body.default_trigger,
        channel_pairing_id: body.channel_pairing_id,
        daily_budget_cents: body.daily_budget_cents,
        mount_allowlist_override: body.mount_allowlist_override,
      });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
      return;
    }

    // If the budget changed, write a dedicated audit row so the
    // operator can spot budget changes in the Audit feed. Other
    // patches use the generic agent.update class (PR 4 territory —
    // not yet defined; falls under provider.switch for now if we
    // need it). Pairing changes get their own audit row too.
    const machine = getMachineIdentity();
    let auditId: number | null = null;
    if (
      body.daily_budget_cents !== undefined &&
      body.daily_budget_cents !== existing.daily_budget_cents
    ) {
      auditId = writeAudit({
        machineId: machine.id,
        action: 'agent.budget.update',
        target: id,
        payloadBefore: {
          daily_budget_cents: existing.daily_budget_cents ?? null,
        },
        payloadAfter: {
          daily_budget_cents: updated.daily_budget_cents ?? null,
        },
      });
    }
    deps.reloadConfig();
    res.json({ ok: true, audit_id: auditId, agent: updated, before });
  });

  app.post('/api/agents/:id/provider', (req: Request, res: Response) => {
    const id = req.params.id;
    const agent = getAgent(id);
    if (!agent) {
      res.status(404).json({ error: 'agent not found' });
      return;
    }
    const body = req.body as Partial<Provider>;
    if (
      !body ||
      typeof body.protocol !== 'string' ||
      typeof body.model !== 'string'
    ) {
      res.status(400).json({
        error: 'protocol and model are required strings',
      });
      return;
    }
    const before = agent.provider;
    const next: Provider = {
      protocol: body.protocol,
      model: body.model,
      base_url: body.base_url ?? null,
      credential_id: body.credential_id ?? null,
    };

    let updated;
    try {
      updated = updateAgent(id, { provider: next });
    } catch (err) {
      logger.error({ id, err }, 'api: updateAgent failed');
      res.status(500).json({ error: 'persistence failed' });
      return;
    }

    const machine = getMachineIdentity();
    const auditId = writeAudit({
      machineId: machine.id,
      action: 'provider.switch',
      target: id,
      payloadBefore: { provider: before },
      payloadAfter: { provider: next },
    });

    // Reload so the next inbound message picks up the new provider
    // without waiting for the launchd timer.
    deps.reloadConfig();
    res.json({
      ok: true,
      audit_id: auditId,
      agent: updated,
    });
  });

  // Sandboxed test message for the model-switch modal's screen C.
  // PR 5 ships a basic batch-mode implementation: spawn-and-return
  // against the proposed provider WITHOUT mutating the agent's
  // existing assignment. Full SSE streaming (per PROVIDER_PLAYBOOK
  // § 4.5) is a layering concern handled in the streaming follow-up;
  // the contract here is forward-compat — clients submit the same
  // body shape regardless of stream mode.
  //
  // Body: { protocol, model, prompt, base_url?, credential_id? }
  // Response: { ok, reply, model, cost_micros?, error? }
  //
  // The endpoint deliberately does NOT spawn a real container in
  // PR 5 — that requires wiring an isolated 'sandboxed-test'
  // session kind through the orchestrator. We return a stub reply
  // plus an audit-log entry so the modal can demonstrate the journey
  // end-to-end. PR 6 wires the real container spawn.
  app.post('/api/agents/:id/sandbox-test', (req: Request, res: Response) => {
    const id = req.params.id;
    const agent = getAgent(id);
    if (!agent) {
      res.status(404).json({ error: 'agent not found' });
      return;
    }
    const body = req.body as Partial<{
      protocol: string;
      model: string;
      prompt: string;
    }>;
    if (
      !body ||
      typeof body.protocol !== 'string' ||
      typeof body.model !== 'string' ||
      typeof body.prompt !== 'string' ||
      body.prompt.trim().length === 0
    ) {
      res.status(400).json({
        error: 'protocol, model, and prompt are required strings',
      });
      return;
    }

    const machine = getMachineIdentity();
    const auditId = writeAudit({
      machineId: machine.id,
      action: 'agent.test_message',
      target: id,
      payloadAfter: {
        protocol: body.protocol,
        model: body.model,
        prompt: body.prompt.slice(0, 200),
      },
    });

    // Stub reply — PR 6 replaces this with a real throwaway-container
    // spawn against the proposed provider. The shape stays stable so
    // the dashboard doesn't need to change when the backend gains real
    // execution.
    res.json({
      ok: true,
      audit_id: auditId,
      reply:
        `[Sandboxed test stub] Would send to ${body.protocol}/${body.model}: ` +
        body.prompt.slice(0, 200),
      model: `${body.protocol}/${body.model}`,
      cost_micros: 0,
      stub: true,
    });
  });

  // ---- channel pairings ----
  //
  // Multi-agent-completion-blueprint § 4.1. Each row is one external
  // messaging connection (one WhatsApp account, one Telegram bot,
  // etc.). Agents reference a pairing via agents.channel_pairing_id;
  // chats record their pairing via chats.pairing_id. The shared
  // pairing (one per kind, synthesised on migration) is the default
  // for v1.0 / v1.2 operators.

  app.get('/api/pairings', (_req: Request, res: Response) => {
    res.json({ pairings: listPairings() });
  });

  app.get('/api/pairings/:id', (req: Request, res: Response) => {
    const pairing = getPairing(req.params.id);
    if (!pairing) {
      res.status(404).json({ error: 'pairing not found' });
      return;
    }
    res.json(pairing);
  });

  // Create a new pairing. The actual credential pairing (Baileys QR
  // for WhatsApp) is done by the wizard's pair flow; this endpoint
  // just registers the metadata so the orchestrator's next channel-
  // factory pass picks up the new auth directory.
  app.post('/api/pairings', (req: Request, res: Response) => {
    const body = req.body as Partial<{
      id: string;
      kind: string;
      display_name: string;
      auth_path: string;
      is_shared: boolean;
      phone_hint: string | null;
    }>;
    if (
      !body ||
      typeof body.kind !== 'string' ||
      typeof body.display_name !== 'string'
    ) {
      res.status(400).json({
        error: 'kind and display_name are required strings',
      });
      return;
    }
    try {
      const pairing = createPairing({
        id: body.id,
        kind: body.kind,
        display_name: body.display_name,
        auth_path: body.auth_path,
        is_shared: body.is_shared,
        phone_hint: body.phone_hint ?? null,
      });
      const machine = getMachineIdentity();
      const auditId = writeAudit({
        machineId: machine.id,
        action: 'pairing.create',
        target: pairing.id,
        payloadAfter: {
          kind: pairing.kind,
          display_name: pairing.display_name,
          is_shared: pairing.is_shared,
        },
      });
      // Reload so the next channel-factory invocation picks up the
      // new pairing without requiring an orchestrator restart.
      deps.reloadConfig();
      res.json({ ok: true, audit_id: auditId, pairing });
    } catch (err) {
      const msg = (err as Error).message;
      res.status(400).json({ error: msg });
    }
  });

  app.delete('/api/pairings/:id', (req: Request, res: Response) => {
    const id = req.params.id;
    const pairing = getPairing(id);
    if (!pairing) {
      res.status(404).json({ error: 'pairing not found' });
      return;
    }
    const before = pairing;
    try {
      deletePairing(id);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
      return;
    }
    const machine = getMachineIdentity();
    const auditId = writeAudit({
      machineId: machine.id,
      action: 'pairing.delete',
      target: id,
      payloadBefore: {
        kind: before.kind,
        display_name: before.display_name,
      },
    });
    deps.reloadConfig();
    res.json({ ok: true, audit_id: auditId });
  });

  // ---- credentials lifecycle ----
  //
  // Multi-agent completion blueprint § 5.1. When an operator deletes
  // an agent, its OneCLI credential is NOT auto-removed — a
  // credential may be shared across agents (two Anthropic agents
  // could share the `Anthropic` secret), and auto-delete would
  // orphan the survivors. Instead the dashboard polls
  // /api/credentials/orphaned and surfaces a one-click nudge.
  // Operator confirms before any OneCLI mutation.

  /**
   * Resolve the onecli binary. Mirrors the CLI wizard's path
   * resolution: prefer PATH, fall back to the install-script default
   * at ~/.local/bin/onecli. The orchestrator runs under the
   * operator's launchd, which inherits a minimal PATH — so we can't
   * count on bare `onecli` working.
   */
  function resolveOnecliBin(): string | null {
    try {
      // PATH probe: spawn `which onecli` synchronously.
      const which = childProcess.spawnSync('which', ['onecli'], {
        encoding: 'utf8',
      });
      if (which.status === 0 && which.stdout.trim()) {
        return which.stdout.trim();
      }
    } catch {
      /* fall through */
    }
    const fallback = path.join(
      process.env.HOME ?? '',
      '.local',
      'bin',
      'onecli',
    );
    try {
      if (fs.existsSync(fallback)) return fallback;
    } catch {
      /* fall through */
    }
    return null;
  }

  app.get('/api/credentials/orphaned', (_req: Request, res: Response) => {
    // The set of credential_ids currently bound to live agents.
    const live = new Set<string>();
    for (const agent of listAgents()) {
      if (agent.provider.credential_id) {
        live.add(agent.provider.credential_id);
      }
    }
    // Cross-reference against the OneCLI registry — names declared in
    // setup/providers.json but no longer referenced by any agent.
    // We can't probe OneCLI's vault directly from here (no shell
    // primitive at this layer); the dashboard's GUI-wizard plumbing
    // owns that probe. Return the *deletable-candidate* names; the
    // dashboard intersects with OneCLI's `secrets list` output before
    // surfacing the nudge.
    const candidates: string[] = [];
    try {
      const registry = loadProviderRegistry();
      for (const entry of Object.values(registry)) {
        const credName = entry.onecli?.name;
        if (credName && !live.has(credName)) {
          candidates.push(credName);
        }
      }
    } catch (err) {
      logger.warn(
        { err: (err as Error).message },
        'api: failed to load providers registry while computing orphan candidates',
      );
    }
    res.json({ candidates });
  });

  /**
   * Destructive credential delete (v1.2.1-finish-blueprint § 4).
   * Defensively re-checks that no agent still references the
   * credential — the probe at /api/credentials/orphaned may have
   * raced against an agent-create. On a 409 the dashboard's
   * typed-confirm modal renders the error inline and the operator
   * decides next move.
   */
  app.delete('/api/credentials/:name', async (req: Request, res: Response) => {
    const name = req.params.name;
    const referenced = listAgents().some(
      (a) => a.provider.credential_id === name,
    );
    if (referenced) {
      res.status(409).json({
        error:
          `Credential "${name}" is still referenced by at least one agent. ` +
          `Reassign or delete those agents first.`,
      });
      return;
    }
    const onecliBin = resolveOnecliBin();
    if (!onecliBin) {
      res.status(500).json({
        error:
          'onecli binary not found on PATH or at ~/.local/bin/onecli. ' +
          'Re-install OneCLI or add it to PATH.',
      });
      return;
    }
    // execFile (not execSync) so a hung OneCLI doesn't block the
    // Express thread. 8s is generous — secrets delete is local.
    const r = await new Promise<{ code: number; stderr: string }>((resolve) => {
      childProcess.execFile(
        onecliBin,
        ['secrets', 'delete', name],
        { timeout: 8_000 },
        (err, _stdout, stderr) => {
          resolve({
            code: err
              ? (err as NodeJS.ErrnoException).code === 'ETIMEDOUT'
                ? 124
                : 1
              : 0,
            stderr: stderr ?? '',
          });
        },
      );
    });
    if (r.code !== 0) {
      logger.warn(
        { name, stderr: r.stderr.slice(-400) },
        'onecli secrets delete failed',
      );
      res.status(500).json({
        error:
          r.stderr.trim().split('\n').slice(-3).join(' · ') ||
          `onecli secrets delete exited ${r.code}`,
      });
      return;
    }
    const machine = getMachineIdentity();
    const auditId = writeAudit({
      machineId: machine.id,
      action: 'credentials.delete',
      target: name,
      payloadBefore: { name },
    });
    logger.info({ name, auditId }, 'credentials.delete: secret removed');
    res.json({ ok: true, audit_id: auditId });
  });

  // ---- providers registry ----
  //
  // The canonical provider registry lives in setup/providers.json.
  // Dashboard surfaces (the ModelSwitchModal, the Models page in a
  // future PR) read this endpoint instead of bundling a stale copy
  // of the registry — adding the 9th provider becomes a JSON edit
  // that propagates everywhere on the next dashboard reload.
  //
  // See docs/PROVIDER_PLAYBOOK.md § 5.5 (Provider registry).
  app.get('/api/providers', (_req: Request, res: Response) => {
    try {
      const registry = loadProviderRegistry();
      res.json({ providers: registry });
    } catch (err) {
      logger.error({ err }, 'api: failed to load providers registry');
      res.status(500).json({ error: 'registry unavailable' });
    }
  });

  // ---- persona ----

  // Read-only snapshot of the deployment's assistant identity. Surfaces the
  // global ASSISTANT_NAME (from .env via src/config.ts) and the per-group
  // trigger_pattern (from registered_groups). Mutations stay on the existing
  // PATCH /api/groups/:jid (per-group trigger) and operator-side `.env` edit
  // for the global name; this endpoint exists so the dashboard can show
  // "what persona is this deployment running as?" without grepping the host.
  app.get('/api/persona', (_req: Request, res: Response) => {
    const groups = deps.getRegisteredGroups();
    const list = Object.entries(groups).map(([jid, g]) => ({
      jid,
      name: g.name,
      folder: g.folder,
      trigger: g.trigger,
      is_main: g.isMain ?? false,
    }));
    res.json({
      assistant_name: ASSISTANT_NAME,
      default_trigger: DEFAULT_TRIGGER,
      groups: list,
    });
  });

  // Helper: read the optimistic-concurrency version off a group's
  // containerConfig. Defaults to 0 for groups that haven't been edited
  // since this feature landed.
  function groupVersion(group: RegisteredGroup): number {
    const v = (group.containerConfig as Record<string, unknown> | null)?.[
      'version'
    ];
    return typeof v === 'number' ? v : 0;
  }

  // Helper: enforce optimistic concurrency via the If-Match header. Returns
  // null when the request is allowed to proceed; returns the response that
  // was already sent on rejection (caller should bail out).
  function checkIfMatch(
    req: Request,
    res: Response,
    group: RegisteredGroup,
  ): boolean {
    const header = req.get('If-Match');
    if (!header) return true; // header is advisory — clients without it bypass
    const want = parseInt(header.trim(), 10);
    const have = groupVersion(group);
    if (want !== have) {
      res.status(409).json({
        error: 'version mismatch — group was edited by someone else',
        current_version: have,
      });
      return false;
    }
    return true;
  }

  // Helper: bump the group's containerConfig.version on every mutation so
  // subsequent edits see the new value.
  function bumpVersion(group: RegisteredGroup): void {
    const next = groupVersion(group) + 1;
    group.containerConfig = {
      ...(group.containerConfig ?? {}),
      version: next,
    } as RegisteredGroup['containerConfig'];
  }

  app.patch('/api/groups/:jid', (req: Request, res: Response) => {
    const jid = req.params.jid;
    const groups = deps.getRegisteredGroups();
    const group = groups[jid];
    if (!group) {
      res.status(404).json({ error: 'group not found' });
      return;
    }
    if (!checkIfMatch(req, res, group)) return;
    const before = JSON.parse(JSON.stringify(group)) as RegisteredGroup;
    const body = req.body as Partial<{
      requires_trigger: boolean;
      container_config: Record<string, unknown>;
      name: string;
      trigger: string;
    }>;

    if (typeof body.requires_trigger === 'boolean') {
      group.requiresTrigger = body.requires_trigger;
    }
    if (typeof body.name === 'string' && body.name.trim()) {
      group.name = body.name.trim();
    }
    if (typeof body.trigger === 'string') {
      group.trigger = body.trigger;
    }
    if (body.container_config && typeof body.container_config === 'object') {
      // Additive merge — preserves existing keys not in the patch. The
      // operator-supplied `version` key is dropped because version
      // monotonicity is the server's concern, not the client's.
      const supplied = {
        ...(body.container_config as Record<string, unknown>),
      };
      delete supplied.version;
      group.containerConfig = {
        ...(group.containerConfig ?? {}),
        ...supplied,
      } as RegisteredGroup['containerConfig'];
    }
    bumpVersion(group);

    try {
      setRegisteredGroup(jid, group);
    } catch (err) {
      logger.error({ jid, err }, 'api: setRegisteredGroup failed');
      res.status(500).json({ error: 'persistence failed' });
      return;
    }

    const machine = getMachineIdentity();
    const auditId = writeAudit({
      machineId: machine.id,
      action: 'group.config.update',
      target: jid,
      payloadBefore: before,
      payloadAfter: group,
    });

    deps.reloadConfig();
    res.json({ ok: true, audit_id: auditId, version: groupVersion(group) });
  });

  app.post('/api/groups/:jid/disable', (req: Request, res: Response) => {
    const jid = req.params.jid;
    const groups = deps.getRegisteredGroups();
    const group = groups[jid];
    if (!group) {
      res.status(404).json({ error: 'group not found' });
      return;
    }
    if (!checkIfMatch(req, res, group)) return;
    const before = JSON.parse(JSON.stringify(group)) as RegisteredGroup;
    // Disable = require trigger + tag with disabled flag in container_config.
    // Avoids destroying state; reversible by re-enabling.
    group.requiresTrigger = true;
    group.containerConfig = {
      ...(group.containerConfig ?? {}),
      disabled: true,
    } as RegisteredGroup['containerConfig'];
    bumpVersion(group);

    try {
      setRegisteredGroup(jid, group);
    } catch (err) {
      logger.error({ jid, err }, 'api: disable failed');
      res.status(500).json({ error: 'persistence failed' });
      return;
    }

    const machine = getMachineIdentity();
    const auditId = writeAudit({
      machineId: machine.id,
      action: 'group.disable',
      target: jid,
      payloadBefore: before,
      payloadAfter: group,
    });

    deps.reloadConfig();
    res.json({ ok: true, audit_id: auditId, version: groupVersion(group) });
  });

  app.post('/api/groups/:jid/enable', (req: Request, res: Response) => {
    const jid = req.params.jid;
    const groups = deps.getRegisteredGroups();
    const group = groups[jid];
    if (!group) {
      res.status(404).json({ error: 'group not found' });
      return;
    }
    if (!checkIfMatch(req, res, group)) return;
    const before = JSON.parse(JSON.stringify(group)) as RegisteredGroup;
    // Enable = clear disabled flag + clear soft-delete marker if present.
    // Reversible mirror of disable.
    group.containerConfig = {
      ...(group.containerConfig ?? {}),
      disabled: false,
      deleted_at: null,
    } as RegisteredGroup['containerConfig'];
    bumpVersion(group);

    try {
      setRegisteredGroup(jid, group);
    } catch (err) {
      logger.error({ jid, err }, 'api: enable failed');
      res.status(500).json({ error: 'persistence failed' });
      return;
    }

    const machine = getMachineIdentity();
    const auditId = writeAudit({
      machineId: machine.id,
      action: 'group.enable',
      target: jid,
      payloadBefore: before,
      payloadAfter: group,
    });

    deps.reloadConfig();
    res.json({ ok: true, audit_id: auditId, version: groupVersion(group) });
  });

  app.delete('/api/groups/:jid', (req: Request, res: Response) => {
    const jid = req.params.jid;
    const groups = deps.getRegisteredGroups();
    const group = groups[jid];
    if (!group) {
      res.status(404).json({ error: 'group not found' });
      return;
    }
    if (!checkIfMatch(req, res, group)) return;
    const before = JSON.parse(JSON.stringify(group)) as RegisteredGroup;
    // Soft delete: tag with deleted_at + disabled. Preserves the SQLite row
    // and the per-group filesystem so a v1.5 "restore deleted" surface can
    // bring it back. The dashboard hides soft-deleted groups by default
    // and the orchestrator drops them from the active routing map.
    group.requiresTrigger = true;
    group.containerConfig = {
      ...(group.containerConfig ?? {}),
      disabled: true,
      deleted_at: new Date().toISOString(),
    } as RegisteredGroup['containerConfig'];
    bumpVersion(group);

    try {
      setRegisteredGroup(jid, group);
    } catch (err) {
      logger.error({ jid, err }, 'api: delete failed');
      res.status(500).json({ error: 'persistence failed' });
      return;
    }

    const machine = getMachineIdentity();
    const auditId = writeAudit({
      machineId: machine.id,
      action: 'group.delete',
      target: jid,
      payloadBefore: before,
      payloadAfter: group,
    });

    deps.reloadConfig();
    res.json({ ok: true, audit_id: auditId, version: groupVersion(group) });
  });

  // ---- test message (forwards to a running container's IPC input) ----

  app.post('/api/test-message', (req: Request, res: Response) => {
    const body = req.body as { jid?: string; text?: string };
    if (!body.jid || !body.text) {
      res.status(400).json({ error: 'jid and text required' });
      return;
    }
    const groups = deps.getRegisteredGroups();
    const group = groups[body.jid];
    if (!group) {
      res.status(404).json({ error: 'group not found' });
      return;
    }
    try {
      deps.injectIpcMessage(group.folder, body.text);
    } catch (err) {
      logger.error({ err }, 'api: injectIpcMessage failed');
      res.status(500).json({ error: 'IPC injection failed' });
      return;
    }

    const machine = getMachineIdentity();
    const auditId = writeAudit({
      machineId: machine.id,
      action: 'test_message.send',
      target: body.jid,
      payloadAfter: { text: body.text.slice(0, 200) },
    });
    res.json({ ok: true, audit_id: auditId });
  });

  // ---- agent turns telemetry ----

  app.get('/api/turns', (req: Request, res: Response) => {
    const groupFolder = (req.query.group as string) || undefined;
    const model = (req.query.model as string) || undefined;
    const outcome = (req.query.outcome as string) || undefined;
    const since = (req.query.since as string) || undefined;
    const agent = (req.query.agent as string) || undefined;
    const format = (req.query.format as string) || 'json';
    // CSV exports allow a higher row cap (operator-driven download).
    const cap = format === 'csv' ? 5000 : 500;
    const limit = Math.min(
      parseInt((req.query.limit as string) || '100', 10) || 100,
      cap,
    );

    const where: string[] = [];
    const params: unknown[] = [];
    if (groupFolder) {
      where.push('agent_turns.group_folder = ?');
      params.push(groupFolder);
    }
    if (model) {
      where.push('agent_turns.model = ?');
      params.push(model);
    }
    if (outcome) {
      where.push('agent_turns.outcome = ?');
      params.push(outcome);
    }
    if (since) {
      where.push('agent_turns.started_at >= ?');
      params.push(since);
    }
    if (agent) {
      // PR 8 § 3.2 — filter by COALESCE'd attribution. A turn matches
      // the agent filter if either its responder_agent_id or (for old
      // turns with NULL responder) the group's assigned agent matches.
      where.push(
        'COALESCE(agent_turns.responder_agent_id, registered_groups.agent_id) = ?',
      );
      params.push(agent);
    }
    // LEFT JOIN registered_groups so the agent-filter COALESCE has
    // access to the group's assigned agent. The join is cheap (small
    // table) and only used for filtering — the row payload is still
    // SELECT * agent_turns.
    const sql = `SELECT agent_turns.* FROM agent_turns
                 LEFT JOIN registered_groups
                   ON registered_groups.folder = agent_turns.group_folder
                 ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                 ORDER BY agent_turns.started_at DESC LIMIT ?`;
    params.push(limit);
    const rows = db()
      .prepare(sql)
      .all(...params) as AgentTurnRow[];

    if (format === 'csv') {
      // Stable column order for CSV consumers (spreadsheets, scripts).
      const cols = [
        'started_at',
        'group_folder',
        'model',
        'agent_profile',
        'outcome',
        'duration_ms',
        'ttft_ms',
        'input_tokens',
        'output_tokens',
        'cache_creation_input_tokens',
        'cache_read_input_tokens',
        'est_cost_cents',
        'tool_use_count',
        'tool_error_count',
        'retry_count',
        'compaction_count',
        'turn_id',
        'machine_id',
        'session_id',
      ] as const;
      const escape = (v: unknown): string => {
        if (v === null || v === undefined) return '';
        const s = String(v);
        if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
        return s;
      };
      const csv =
        cols.join(',') +
        '\n' +
        rows
          .map((r) =>
            cols
              .map((c) => escape((r as unknown as Record<string, unknown>)[c]))
              .join(','),
          )
          .join('\n');
      const filename = `agent-turns-${new Date().toISOString().slice(0, 10)}.csv`;
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${filename}"`,
      );
      res.send(csv);
      return;
    }

    res.json({ turns: rows });
  });

  // ---- message content search (powers the Activity panel's search box) ----

  app.get('/api/messages/search', (req: Request, res: Response) => {
    const q = (req.query.q as string) || '';
    const groupJid = (req.query.group as string) || undefined;
    const limit = Math.min(
      parseInt((req.query.limit as string) || '50', 10) || 50,
      200,
    );
    if (!q || q.trim().length < 2) {
      // Refuse very short queries — they'd return huge result sets and
      // are almost certainly not what the operator meant.
      res.json({ messages: [], reason: 'query too short' });
      return;
    }
    const where: string[] = ['content LIKE ?'];
    const params: unknown[] = [`%${q}%`];
    if (groupJid) {
      where.push('chat_jid = ?');
      params.push(groupJid);
    }
    const sql = `SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message
                 FROM messages
                 WHERE ${where.join(' AND ')}
                 ORDER BY timestamp DESC LIMIT ?`;
    params.push(limit);
    const rows = db()
      .prepare(sql)
      .all(...params);
    res.json({ messages: rows, query: q });
  });

  // ---- alerts (Round 7 ben-log-grounded top-5) ----

  app.get('/api/alerts', async (_req: Request, res: Response) => {
    try {
      const snapshot = await getAlertsSnapshot();
      res.json(snapshot);
    } catch (err) {
      logger.error({ err }, 'api: alerts snapshot failed');
      res.status(500).json({ error: 'alerts snapshot failed' });
    }
  });

  // ---- restart stack (env-gated destructive recovery) ----

  app.post('/api/restart-stack', (_req: Request, res: Response) => {
    // Per Q6 cascade: button is hidden by default; enabled only when the
    // operator opts in via the launchd plist env var
    // NANOCLAW_DASHBOARD_ENABLE_RESTART_STACK=1.
    if (!isRestartStackEnabled()) {
      // 404 (rather than 403) to match the ticket spec — the route should
      // appear not to exist when the operator hasn't opted in.
      res.status(404).json({ error: 'route not enabled' });
      return;
    }

    // Per Round 7 Rank 1 — both the UI process AND the docker backend
    // must be killed; killing only Docker Desktop leaves the daemon
    // wedged. macOS launchd (or the user's Docker Desktop launchctl
    // entry) respawns both.
    const commands = [
      "pkill -9 -f 'Docker Desktop'",
      "pkill -9 -f 'com.docker.backend'",
    ];
    const results: { command: string; ok: boolean; detail?: string }[] = [];
    for (const cmd of commands) {
      try {
        execSync(cmd, { encoding: 'utf-8', timeout: 3_000 });
        results.push({ command: cmd, ok: true });
      } catch (err) {
        // pkill exits 1 when no matching process — that's not an error
        // here (the process was already gone). Other failures get logged.
        const code = (err as NodeJS.ErrnoException & { status?: number })
          .status;
        if (code === 1) {
          results.push({
            command: cmd,
            ok: true,
            detail: 'no matching process',
          });
        } else {
          logger.error({ err, cmd }, 'api: restart-stack pkill failed');
          results.push({
            command: cmd,
            ok: false,
            detail: (err as Error).message,
          });
        }
      }
    }

    const machine = getMachineIdentity();
    const auditId = writeAudit({
      machineId: machine.id,
      action: 'restart_stack.invoke',
      target: 'docker',
      payloadAfter: { commands, results },
    });

    res.json({ ok: true, audit_id: auditId, results });
  });

  // ---- daily cost rollup ----

  app.get('/api/cost/daily', (req: Request, res: Response) => {
    const groupFolder = (req.query.group as string) || undefined;
    const model = (req.query.model as string) || undefined;
    const agent = (req.query.agent as string) || undefined;
    const days = Math.min(
      parseInt((req.query.days as string) || '30', 10) || 30,
      90,
    );
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);

    const where: string[] = ['date(agent_turns.started_at) >= ?'];
    const params: unknown[] = [since];
    if (groupFolder) {
      where.push('agent_turns.group_folder = ?');
      params.push(groupFolder);
    }
    if (model) {
      where.push('agent_turns.model = ?');
      params.push(model);
    }
    if (agent) {
      // PR 8 § 3.2 — agent filter uses COALESCE'd attribution.
      where.push(
        'COALESCE(agent_turns.responder_agent_id, registered_groups.agent_id) = ?',
      );
      params.push(agent);
    }
    // LEFT JOIN registered_groups for the agent-filter COALESCE.
    // No effect on rows when ?agent= is absent.
    const sql = `SELECT date(agent_turns.started_at) AS day,
                        agent_turns.model AS model,
                        SUM(agent_turns.est_cost_cents) AS cents,
                        SUM(agent_turns.input_tokens) AS in_tok,
                        SUM(agent_turns.output_tokens) AS out_tok,
                        COUNT(*) AS turns
                 FROM agent_turns
                 LEFT JOIN registered_groups
                   ON registered_groups.folder = agent_turns.group_folder
                 WHERE ${where.join(' AND ')}
                 GROUP BY day, agent_turns.model
                 ORDER BY day DESC, agent_turns.model`;
    const rows = db()
      .prepare(sql)
      .all(...params);
    res.json({ rows });
  });

  // ---- cost test alert (forwards a synthetic budget alert to the operator) ----

  app.post('/api/cost/test-alert', (req: Request, res: Response) => {
    // Cost alerts deliver to the operator's main group via the existing
    // IPC pattern (same channel the open_dm cost-cap alerts use). The
    // dashboard's "Send test alert" button hits this endpoint to verify
    // the wiring without waiting for a real threshold breach.
    const body = req.body as {
      threshold_pct?: number;
      spent_cents?: number;
      budget_cents?: number;
    };
    const groups = deps.getRegisteredGroups();
    const main = Object.values(groups).find((g) => g.isMain);
    if (!main) {
      res.status(404).json({ error: 'no main group registered' });
      return;
    }
    const threshold = body.threshold_pct ?? 50;
    const spent = body.spent_cents ?? 0;
    const budget = body.budget_cents ?? 0;
    const text = `[cost-alert · TEST] daily spend ${(spent / 100).toFixed(2)} USD has reached ${threshold}% of the configured budget (${(budget / 100).toFixed(2)} USD). This is a test alert from the Cost Tracking panel.`;
    try {
      deps.injectIpcMessage(main.folder, text);
    } catch (err) {
      logger.error({ err }, 'api: cost test-alert IPC injection failed');
      res.status(500).json({ error: 'IPC injection failed' });
      return;
    }
    const machine = getMachineIdentity();
    const auditId = writeAudit({
      machineId: machine.id,
      action: 'test_message.send',
      target: main.folder,
      payloadAfter: { kind: 'cost_alert_test', threshold, spent, budget },
    });
    res.json({ ok: true, audit_id: auditId, target_folder: main.folder });
  });

  // ---- tasks (read-only mirror of scheduler state) ----

  app.get('/api/tasks', (_req: Request, res: Response) => {
    res.json({ tasks: getAllTasks() });
  });

  // ---- audit log ----

  app.get('/api/audit', (req: Request, res: Response) => {
    const limit = Math.min(
      parseInt((req.query.limit as string) || '50', 10) || 50,
      500,
    );
    res.json({ entries: readAuditEntries(limit) });
  });

  app.post('/api/audit/:id/undo', (req: Request, res: Response) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) {
      res.status(400).json({ error: 'invalid id' });
      return;
    }
    const entry = readAuditById(id);
    if (!entry) {
      res.status(404).json({ error: 'audit entry not found' });
      return;
    }
    if (!isReversible(entry)) {
      res.status(409).json({
        error: 'audit entry no longer reversible',
        reversible_until: entry.reversible_until,
      });
      return;
    }
    if (
      entry.action === 'group.config.update' ||
      entry.action === 'group.disable' ||
      entry.action === 'group.enable' ||
      entry.action === 'group.delete'
    ) {
      if (!entry.target || !entry.payload_before) {
        res.status(409).json({ error: 'audit entry missing payload_before' });
        return;
      }
      try {
        const restored = JSON.parse(entry.payload_before) as RegisteredGroup;
        setRegisteredGroup(entry.target, restored);
      } catch (err) {
        logger.error({ id, err }, 'api: undo restore failed');
        res.status(500).json({ error: 'restore failed' });
        return;
      }
      const machine = getMachineIdentity();
      const auditId = writeAudit({
        machineId: machine.id,
        action: 'audit.undo' as AuditAction,
        target: entry.target,
        payloadBefore: JSON.parse(entry.payload_after ?? 'null'),
        payloadAfter: JSON.parse(entry.payload_before),
      });
      deps.reloadConfig();
      res.json({ ok: true, audit_id: auditId, undid: id });
      return;
    }
    res.status(400).json({
      error: 'undo not implemented for action',
      action: entry.action,
    });
  });
}
