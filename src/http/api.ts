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
import {
  AgentTurnRow,
  getAllTasks,
  setRegisteredGroup,
} from '../db.js';
import Database from 'better-sqlite3';
import path from 'path';
import { STORE_DIR } from '../config.js';
import { logger } from '../logger.js';
import { RegisteredGroup } from '../types.js';
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
    const list = Object.entries(groups).map(([jid, g]) => ({
      jid,
      name: g.name,
      folder: g.folder,
      trigger: g.trigger,
      added_at: g.added_at,
      requires_trigger: g.requiresTrigger ?? true,
      is_main: g.isMain ?? false,
      container_config: g.containerConfig ?? null,
    }));
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

  app.patch('/api/groups/:jid', (req: Request, res: Response) => {
    const jid = req.params.jid;
    const groups = deps.getRegisteredGroups();
    const group = groups[jid];
    if (!group) {
      res.status(404).json({ error: 'group not found' });
      return;
    }
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
      // Additive merge — preserves existing keys not in the patch.
      group.containerConfig = {
        ...(group.containerConfig ?? {}),
        ...(body.container_config as Record<string, unknown>),
      } as RegisteredGroup['containerConfig'];
    }

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
    res.json({ ok: true, audit_id: auditId });
  });

  app.post('/api/groups/:jid/disable', (req: Request, res: Response) => {
    const jid = req.params.jid;
    const groups = deps.getRegisteredGroups();
    const group = groups[jid];
    if (!group) {
      res.status(404).json({ error: 'group not found' });
      return;
    }
    const before = JSON.parse(JSON.stringify(group)) as RegisteredGroup;
    // Disable = require trigger + tag with disabled flag in container_config.
    // Avoids destroying state; reversible by re-enabling.
    group.requiresTrigger = true;
    group.containerConfig = {
      ...(group.containerConfig ?? {}),
      disabled: true,
    } as RegisteredGroup['containerConfig'];

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
    res.json({ ok: true, audit_id: auditId });
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
    const since = (req.query.since as string) || undefined;
    const limit = Math.min(parseInt((req.query.limit as string) || '100', 10) || 100, 500);

    const where: string[] = [];
    const params: unknown[] = [];
    if (groupFolder) {
      where.push('group_folder = ?');
      params.push(groupFolder);
    }
    if (since) {
      where.push('started_at >= ?');
      params.push(since);
    }
    const sql = `SELECT * FROM agent_turns ${
      where.length ? 'WHERE ' + where.join(' AND ') : ''
    } ORDER BY started_at DESC LIMIT ?`;
    params.push(limit);
    const rows = db()
      .prepare(sql)
      .all(...params) as AgentTurnRow[];
    res.json({ turns: rows });
  });

  // ---- daily cost rollup ----

  app.get('/api/cost/daily', (req: Request, res: Response) => {
    const groupFolder = (req.query.group as string) || undefined;
    const model = (req.query.model as string) || undefined;
    const days = Math.min(parseInt((req.query.days as string) || '30', 10) || 30, 90);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);

    const where: string[] = ['date(started_at) >= ?'];
    const params: unknown[] = [since];
    if (groupFolder) {
      where.push('group_folder = ?');
      params.push(groupFolder);
    }
    if (model) {
      where.push('model = ?');
      params.push(model);
    }
    const sql = `SELECT date(started_at) AS day, model, SUM(est_cost_cents) AS cents,
                        SUM(input_tokens) AS in_tok, SUM(output_tokens) AS out_tok,
                        COUNT(*) AS turns
                 FROM agent_turns
                 WHERE ${where.join(' AND ')}
                 GROUP BY day, model
                 ORDER BY day DESC, model`;
    const rows = db()
      .prepare(sql)
      .all(...params);
    res.json({ rows });
  });

  // ---- tasks (read-only mirror of scheduler state) ----

  app.get('/api/tasks', (_req: Request, res: Response) => {
    res.json({ tasks: getAllTasks() });
  });

  // ---- audit log ----

  app.get('/api/audit', (req: Request, res: Response) => {
    const limit = Math.min(parseInt((req.query.limit as string) || '50', 10) || 50, 500);
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
    if (entry.action === 'group.config.update' || entry.action === 'group.disable' || entry.action === 'group.enable') {
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
