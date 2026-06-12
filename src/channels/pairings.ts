/**
 * Channel-pairing CRUD + lookup helpers.
 *
 * A pairing represents one external messaging connection — for
 * WhatsApp, one Baileys auth state directory; for Telegram, one bot
 * token; etc. The orchestrator can run multiple pairings of the same
 * kind simultaneously (the multi-agent positioning option B from
 * multi-agent-completion-blueprint § 4.1).
 *
 * Every chat row carries `pairing_id`. On inbound, the channel
 * stamps `chats.pairing_id` with its own pairing id. On outbound,
 * the orchestrator's router looks up `chats.pairing_id` for the
 * target chat and finds the channel whose pairing matches.
 *
 * Schema lives in `src/db.ts`'s `createSchema()` — see the
 * `channel_pairings` table.
 */

import path from 'path';

import { STORE_DIR } from '../config.js';
import { getDb } from '../db.js';
import { logger } from '../logger.js';

export interface ChannelPairing {
  /** Stable slug; the channel's name becomes `<kind>:<id>`. */
  id: string;
  /** One of 'whatsapp', 'telegram', 'slack', etc. */
  kind: string;
  /** Operator-facing display name, e.g. "Shared WhatsApp" or "Ben's number". */
  display_name: string;
  /** Absolute path to the credentials directory for this pairing. */
  auth_path: string;
  /**
   * Whether this pairing is the deployment's default — agents created
   * without an explicit choice land here. Exactly one row per `kind`
   * should be `is_shared = true` on a healthy deployment.
   */
  is_shared: boolean;
  /** Operator-supplied hint, e.g. "+27 82 …". Never the credential. */
  phone_hint: string | null;
  /** ISO-8601 of the last successful Baileys connection. */
  last_connected_at: string | null;
  /** ISO-8601 of creation. */
  created_at: string;
}

interface PairingRow {
  id: string;
  kind: string;
  display_name: string;
  auth_path: string;
  is_shared: number;
  phone_hint: string | null;
  last_connected_at: string | null;
  created_at: string;
}

function rowToPairing(row: PairingRow): ChannelPairing {
  return {
    id: row.id,
    kind: row.kind,
    display_name: row.display_name,
    auth_path: row.auth_path,
    is_shared: row.is_shared === 1,
    phone_hint: row.phone_hint,
    last_connected_at: row.last_connected_at,
    created_at: row.created_at,
  };
}

/** List every pairing across all channel kinds. */
export function listPairings(): ChannelPairing[] {
  const rows = getDb()
    .prepare(
      `SELECT id, kind, display_name, auth_path, is_shared,
              phone_hint, last_connected_at, created_at
         FROM channel_pairings
         ORDER BY is_shared DESC, created_at ASC`,
    )
    .all() as PairingRow[];
  return rows.map(rowToPairing);
}

/** List pairings for one channel kind (e.g. 'whatsapp'). */
export function listPairingsForKind(kind: string): ChannelPairing[] {
  const rows = getDb()
    .prepare(
      `SELECT id, kind, display_name, auth_path, is_shared,
              phone_hint, last_connected_at, created_at
         FROM channel_pairings
         WHERE kind = ?
         ORDER BY is_shared DESC, created_at ASC`,
    )
    .all(kind) as PairingRow[];
  return rows.map(rowToPairing);
}

export function getPairing(id: string): ChannelPairing | null {
  const row = getDb()
    .prepare(
      `SELECT id, kind, display_name, auth_path, is_shared,
              phone_hint, last_connected_at, created_at
         FROM channel_pairings WHERE id = ?`,
    )
    .get(id) as PairingRow | undefined;
  return row ? rowToPairing(row) : null;
}

/**
 * Return the deployment's default pairing for a channel kind. Falls
 * back to the first pairing if no row is marked `is_shared`.
 */
export function getDefaultPairing(kind: string): ChannelPairing | null {
  const row = getDb()
    .prepare(
      `SELECT id, kind, display_name, auth_path, is_shared,
              phone_hint, last_connected_at, created_at
         FROM channel_pairings
         WHERE kind = ?
         ORDER BY is_shared DESC, created_at ASC LIMIT 1`,
    )
    .get(kind) as PairingRow | undefined;
  return row ? rowToPairing(row) : null;
}

/**
 * Return the pairing recorded for a chat — `chats.pairing_id`.
 * Returns null when the chat is unknown or pre-migration (very rare;
 * the migration backfills all existing chats).
 */
export function getPairingForChat(chatJid: string): ChannelPairing | null {
  const row = getDb()
    .prepare(
      `SELECT cp.id, cp.kind, cp.display_name, cp.auth_path, cp.is_shared,
              cp.phone_hint, cp.last_connected_at, cp.created_at
         FROM chats
         JOIN channel_pairings cp ON cp.id = chats.pairing_id
        WHERE chats.jid = ?`,
    )
    .get(chatJid) as PairingRow | undefined;
  return row ? rowToPairing(row) : null;
}

export interface CreatePairingInput {
  /** Optional explicit id; defaults to `<kind>-<slug-of-display-name>`. */
  id?: string;
  kind: string;
  display_name: string;
  /**
   * Absolute path to the credentials directory. Defaults to
   * `store/auth-<id>/` for non-shared pairings. The shared pairing
   * uses the legacy `store/auth/` directly.
   */
  auth_path?: string;
  is_shared?: boolean;
  phone_hint?: string | null;
}

export function createPairing(input: CreatePairingInput): ChannelPairing {
  const id = input.id ?? slugifyPairingId(input.kind, input.display_name);
  if (getPairing(id)) {
    throw new Error(`Pairing with id '${id}' already exists`);
  }
  const isShared = input.is_shared === true;
  // Auth directory: shared pairings inherit the legacy path; new
  // pairings get an isolated directory `store/auth-<id>/`.
  const authPath =
    input.auth_path ??
    (isShared
      ? path.join(STORE_DIR, 'auth')
      : path.join(STORE_DIR, `auth-${id}`));
  const createdAt = new Date().toISOString();
  const db = getDb();
  const tx = db.transaction(() => {
    if (isShared) {
      // Demote any other shared row of the same kind. Exactly one
      // shared row per kind.
      db.prepare(
        `UPDATE channel_pairings SET is_shared = 0
            WHERE kind = ? AND is_shared = 1`,
      ).run(input.kind);
    }
    db.prepare(
      `INSERT INTO channel_pairings
         (id, kind, display_name, auth_path, is_shared,
          phone_hint, last_connected_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`,
    ).run(
      id,
      input.kind,
      input.display_name,
      authPath,
      isShared ? 1 : 0,
      input.phone_hint ?? null,
      createdAt,
    );
  });
  tx();
  const pairing = getPairing(id);
  if (!pairing) {
    throw new Error(`createPairing: insert succeeded but read missed`);
  }
  logger.info(
    {
      pairingId: pairing.id,
      kind: pairing.kind,
      authPath: pairing.auth_path,
      isShared: pairing.is_shared,
    },
    'Created channel pairing',
  );
  return pairing;
}

export interface UpdatePairingPatch {
  display_name?: string;
  phone_hint?: string | null;
  last_connected_at?: string | null;
}

export function updatePairing(
  id: string,
  patch: UpdatePairingPatch,
): ChannelPairing {
  const existing = getPairing(id);
  if (!existing) throw new Error(`Unknown pairing id: ${id}`);
  const next: ChannelPairing = {
    ...existing,
    display_name: patch.display_name ?? existing.display_name,
    phone_hint:
      patch.phone_hint !== undefined ? patch.phone_hint : existing.phone_hint,
    last_connected_at:
      patch.last_connected_at !== undefined
        ? patch.last_connected_at
        : existing.last_connected_at,
  };
  getDb()
    .prepare(
      `UPDATE channel_pairings
          SET display_name = ?, phone_hint = ?, last_connected_at = ?
        WHERE id = ?`,
    )
    .run(next.display_name, next.phone_hint, next.last_connected_at, id);
  return next;
}

/**
 * Delete a pairing. Refuses to delete the shared pairing for any
 * kind (must promote another first). Reassigns every chat + agent
 * pointing at the deleted pairing to the kind's remaining shared
 * pairing so no row is orphaned.
 */
export function deletePairing(id: string): void {
  const pairing = getPairing(id);
  if (!pairing) throw new Error(`Unknown pairing id: ${id}`);
  if (pairing.is_shared) {
    throw new Error(`Cannot delete the shared pairing. Promote another first.`);
  }
  const fallback = getDefaultPairing(pairing.kind);
  if (!fallback || fallback.id === id) {
    throw new Error(
      `No replacement pairing of kind '${pairing.kind}'; aborting delete.`,
    );
  }
  const db = getDb();
  const tx = db.transaction(() => {
    db.prepare(`UPDATE chats SET pairing_id = ? WHERE pairing_id = ?`).run(
      fallback.id,
      id,
    );
    db.prepare(
      `UPDATE agents SET channel_pairing_id = ? WHERE channel_pairing_id = ?`,
    ).run(fallback.id, id);
    db.prepare(`DELETE FROM channel_pairings WHERE id = ?`).run(id);
  });
  tx();
  logger.info(
    { pairingId: id, reassignedTo: fallback.id },
    'Deleted pairing and reassigned its chats/agents',
  );
}

/**
 * Stamp `chats.pairing_id` for an inbound message. Idempotent —
 * later inbounds from the same JID re-confirm the binding. When the
 * chat already has a different pairing recorded (rare — operator
 * connected the same number via a different pairing later), we
 * keep the new pairing because the latest connection is the
 * canonical one.
 */
export function recordChatPairing(chatJid: string, pairingId: string): void {
  getDb()
    .prepare(`UPDATE chats SET pairing_id = ? WHERE jid = ?`)
    .run(pairingId, chatJid);
}

/**
 * Touch the pairing's `last_connected_at`. Called when the channel's
 * websocket fully opens. Dashboard surfaces this so operators can
 * spot a dropped pairing.
 */
export function recordPairingConnected(id: string): void {
  getDb()
    .prepare(`UPDATE channel_pairings SET last_connected_at = ? WHERE id = ?`)
    .run(new Date().toISOString(), id);
}

function slugifyPairingId(kind: string, displayName: string): string {
  const slug =
    displayName
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '') || 'pairing';
  return `${kind}-${slug}`;
}
