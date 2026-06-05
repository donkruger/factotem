/**
 * Shared DB probe for setup steps that read store/messages.db.
 *
 * Why this exists: several setup steps (verify, environment) need the
 * registered-group count. They all open the DB via better-sqlite3, which loads
 * a native addon. If that addon was compiled against a different Node.js ABI
 * than the Node now running the step (NODE_MODULE_VERSION mismatch — common when
 * the launchd/systemd service runs one Node and the interactive `npx tsx` path
 * resolves another), the `new Database()` constructor THROWS.
 *
 * The historical bug: each call site wrapped this in a bare `catch {}` and let a
 * *failed read* fall through as "0 groups". A read failure is NOT zero groups —
 * conflating them turned a healthy install into a false `STATUS: failed`. This
 * module makes the three states explicit and never reports a throw as 0.
 */
import fs from 'fs';

import Database from 'better-sqlite3';

export interface RegisteredGroupProbe {
  /**
   * Number of rows in `registered_groups`, or `null` when the count could not
   * be determined (the DB existed but could not be read). `null` is "unknown",
   * NOT zero — callers must not treat it as "no groups".
   */
  count: number | null;
  /**
   * Single-line error message when the DB existed but the read threw; `null`
   * on success or when the DB file is simply absent (a fresh install).
   */
  error: string | null;
}

/** True when an error message is better-sqlite3's native-ABI mismatch — i.e.
 *  the addon was built against a different Node.js than the one running now. */
export function isAbiMismatch(message: string): boolean {
  return /NODE_MODULE_VERSION/.test(message);
}

/**
 * Actionable, operator-facing hint for a DB-read error. ABI mismatches get
 * specific guidance (the dominant real-world cause); anything else gets a
 * generic pointer to the log. Always a single line so it survives the
 * `KEY: value` status-block format consumed by the wizard / claw / GUI doctor.
 */
export function dbErrorHint(message: string): string {
  if (isAbiMismatch(message)) {
    return (
      'better-sqlite3 was built against a different Node.js version than the ' +
      'one running this command. Run setup with the same Node that runs the ' +
      'service (e.g. /opt/homebrew/bin/node on the launchd PATH), or rebuild ' +
      'with that Node: `npm rebuild better-sqlite3`.'
    );
  }
  return 'Could not read store/messages.db; see logs/setup.log for the full error.';
}

/**
 * Count rows in `registered_groups`, distinguishing three states:
 *   - DB file absent          → { count: 0,    error: null } (fresh install)
 *   - DB present, read OK      → { count: N,    error: null } (N may legitimately be 0)
 *   - DB present, read THROWS  → { count: null, error: msg  } (e.g. ABI mismatch)
 *
 * A throw is NEVER reported as 0 — that conflation is the bug this guards. The
 * error message is collapsed to a single line so it can be emitted verbatim in
 * a status block. This function is pure (no logging / no process exit); callers
 * decide how to surface `error`.
 */
export function readRegisteredGroupCount(dbPath: string): RegisteredGroupProbe {
  if (!fs.existsSync(dbPath)) {
    return { count: 0, error: null };
  }
  let db: Database.Database | undefined;
  try {
    db = new Database(dbPath, { readonly: true });
    const row = db
      .prepare('SELECT COUNT(*) as count FROM registered_groups')
      .get() as { count: number } | undefined;
    return { count: row?.count ?? 0, error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { count: null, error: message.replace(/\s+/g, ' ').trim() };
  } finally {
    db?.close();
  }
}
