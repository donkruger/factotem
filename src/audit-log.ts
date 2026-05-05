/**
 * Audit-log helpers for operator-action API state changes.
 *
 * Every state-changing /api/* endpoint writes one row before performing
 * the action. Reversible operations record the prior payload + a
 * reversibility window so the dashboard's "Undo" button can restore the
 * pre-change state.
 *
 * T-1778236000000 (Phase 0.5 of Factotem Dashboard v1 epic).
 *
 * Per Q1 of the dashboard decisions, v1 has no per-operator attribution
 * (Tailscale-trust = single operator implicit). The actor column is a
 * constant 'operator' string. Multi-operator attribution arrives in
 * v1.5 with the auth deliverables.
 */

import Database from 'better-sqlite3';
import path from 'path';

import { STORE_DIR } from './config.js';

let auditDb: Database.Database | undefined;

function getDb(): Database.Database {
  if (!auditDb) {
    // Reuse the same SQLite file as the rest of the app
    auditDb = new Database(path.join(STORE_DIR, 'messages.db'));
  }
  return auditDb;
}

export type AuditAction =
  | 'group.config.update'
  | 'group.disable'
  | 'group.enable'
  | 'group.delete'
  | 'profile.update'
  | 'openMode.update'
  | 'test_message.send'
  | 'audit.undo';

const REVERSIBILITY_BY_ACTION: Record<AuditAction, number> = {
  // ms — how long the operation can be undone
  'group.config.update': 5 * 60 * 1000, // 5 min
  'group.disable': 24 * 60 * 60 * 1000, // 24h (just re-enable)
  'group.enable': 5 * 60 * 1000,
  'group.delete': 24 * 60 * 60 * 1000,
  'profile.update': 60 * 60 * 1000, // 1h (more consequential)
  'openMode.update': 5 * 60 * 1000,
  'test_message.send': 0, // not reversible (already sent)
  'audit.undo': 0, // an undo is not itself undoable
};

export interface AuditEntry {
  id: number;
  machine_id: string;
  ts: string;
  actor: string;
  action: string;
  target: string | null;
  payload_before: string | null;
  payload_after: string | null;
  reversible_until: string | null;
}

/**
 * Write an audit row. Returns the row's id so the caller can reference it
 * in subsequent operations or surface it for direct undo.
 */
export function writeAudit(args: {
  machineId: string;
  action: AuditAction;
  target?: string;
  payloadBefore?: unknown;
  payloadAfter?: unknown;
}): number {
  const ts = new Date().toISOString();
  const reversibilityMs = REVERSIBILITY_BY_ACTION[args.action] ?? 0;
  const reversibleUntil =
    reversibilityMs > 0
      ? new Date(Date.now() + reversibilityMs).toISOString()
      : null;
  const result = getDb()
    .prepare(
      `INSERT INTO audit_log (
        machine_id, ts, actor, action, target,
        payload_before, payload_after, reversible_until
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      args.machineId,
      ts,
      'operator',
      args.action,
      args.target ?? null,
      args.payloadBefore != null ? JSON.stringify(args.payloadBefore) : null,
      args.payloadAfter != null ? JSON.stringify(args.payloadAfter) : null,
      reversibleUntil,
    );
  return Number(result.lastInsertRowid);
}

export function readAuditEntries(limit: number = 50): AuditEntry[] {
  return getDb()
    .prepare(
      `SELECT id, machine_id, ts, actor, action, target,
              payload_before, payload_after, reversible_until
       FROM audit_log ORDER BY ts DESC LIMIT ?`,
    )
    .all(limit) as AuditEntry[];
}

export function readAuditById(id: number): AuditEntry | undefined {
  return getDb()
    .prepare(
      `SELECT id, machine_id, ts, actor, action, target,
              payload_before, payload_after, reversible_until
       FROM audit_log WHERE id = ?`,
    )
    .get(id) as AuditEntry | undefined;
}

export function isReversible(entry: AuditEntry): boolean {
  if (!entry.reversible_until) return false;
  return new Date(entry.reversible_until).getTime() > Date.now();
}
