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
  | 'restart_stack.invoke'
  | 'audit.undo'
  // Gemini blueprint PR 5 (Phase E.4) — agent-level operations.
  | 'provider.switch'
  | 'agent.test_message'
  // Multi-agent-completion-blueprint § 4.1 — channel pairing lifecycle.
  | 'pairing.create'
  | 'pairing.delete'
  // Multi-agent-completion-blueprint § 4.2 — per-agent open-DM budget.
  | 'agent.budget.update'
  // v1.2.1-finish-blueprint § 4 — destructive credential removal.
  // Typed-confirm gates the click; the audit row records who/when
  // for the operator's after-the-fact reconstruction.
  | 'credentials.delete';

const REVERSIBILITY_BY_ACTION: Record<AuditAction, number> = {
  // ms — how long the operation can be undone
  'group.config.update': 5 * 60 * 1000, // 5 min
  'group.disable': 24 * 60 * 60 * 1000, // 24h (just re-enable)
  'group.enable': 5 * 60 * 1000,
  'group.delete': 24 * 60 * 60 * 1000,
  'profile.update': 60 * 60 * 1000, // 1h (more consequential)
  'openMode.update': 5 * 60 * 1000,
  'test_message.send': 0, // not reversible (already sent)
  'restart_stack.invoke': 0, // not reversible (process already killed)
  'audit.undo': 0, // an undo is not itself undoable
  // 5-minute window for provider switches — long enough for an operator
  // to notice the new model misbehaves on the first exchange and roll
  // back, short enough that a meaningfully-different conversation has
  // happened by the time the window closes. Per PROVIDER_PLAYBOOK § 4.3
  // (switch is reversible without data loss; container spawns fresh on
  // the next inbound message).
  'provider.switch': 5 * 60 * 1000,
  'agent.test_message': 0, // ephemeral; nothing on disk to revert
  // Pairing creates: 24h to undo (operator can delete the pairing
  // from the dashboard). Auth state on disk persists until explicit
  // delete, so this is just for the convenience-undo case.
  'pairing.create': 24 * 60 * 60 * 1000,
  'pairing.delete': 0, // not reversible (auth state is wiped)
  // Budget updates: 5 min like the provider-switch window. Long
  // enough for an operator to spot a surprising spend curve and
  // raise the cap back, short enough to keep the audit list focused.
  'agent.budget.update': 5 * 60 * 1000,
  // Credential deletion is destructive — the typed-confirm modal
  // raises the cost of the click, and the row in the OneCLI vault
  // is gone after this fires. Operators re-paste the API key via
  // the wizard if they want it back; nothing to undo from the
  // audit page.
  'credentials.delete': 0,
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
