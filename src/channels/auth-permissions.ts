/**
 * Auth-permissions hardening for Baileys-managed credential files.
 *
 * Baileys writes session keys, pre-keys, and sender-keys to
 * `store/auth/` continuously during runtime. By default, Node.js
 * `fs.writeFileSync` honours the process umask which on macOS / typical
 * Linux defaults to 022 — producing world-readable files (mode 644).
 *
 * On Don's single-user Mac, no active exploit path. But if NanoClaw is
 * ever cloned to a multi-user host, Bob deployment, or shared server,
 * those credentials become readable by every local process. This module
 * locks the directory's contents to mode 0o600 (owner-only) on every
 * write.
 *
 * Phase 0.6 of T-1778232000000 (Factotem Dashboard v1 epic).
 * Verified vulnerability: see ben-log/2026-05-03-baileys-creds-world-readable.md.
 */

import fs from 'fs';
import path from 'path';

import { logger } from '../logger.js';

const SECURE_MODE = 0o600;

/**
 * Lock all files in `authDir` to owner-only permissions immediately, then
 * watch for new writes and chmod each one as it lands. Idempotent — safe
 * to call once per channel-connect cycle.
 *
 * Failures are logged but never thrown: if `fs.watch` is unavailable on
 * the platform, the initial walk still tightens existing files; new
 * writes during the session would fall back to the default umask, but
 * the next `secureAuthDir` call (e.g. on next startup) re-tightens them.
 */
export function secureAuthDir(authDir: string): void {
  // Initial walk — tighten any pre-existing files
  try {
    if (!fs.existsSync(authDir)) {
      return;
    }
    let count = 0;
    for (const entry of fs.readdirSync(authDir)) {
      const full = path.join(authDir, entry);
      try {
        const stat = fs.statSync(full);
        if (stat.isFile() && (stat.mode & 0o777) !== SECURE_MODE) {
          fs.chmodSync(full, SECURE_MODE);
          count++;
        }
      } catch (err) {
        logger.debug(
          { err, file: full },
          'auth-permissions: skip file (stat/chmod failed)',
        );
      }
    }
    if (count > 0) {
      logger.info(
        { authDir, tightened: count },
        'auth-permissions: initial chmod 0o600 complete',
      );
    }
  } catch (err) {
    logger.warn({ err, authDir }, 'auth-permissions: initial walk failed');
  }

  // Live watcher — chmod 0o600 on every file write
  try {
    const watcher = fs.watch(
      authDir,
      { persistent: false },
      (_event, filename) => {
        if (!filename) return;
        const full = path.join(authDir, filename);
        try {
          if (fs.existsSync(full) && fs.statSync(full).isFile()) {
            fs.chmodSync(full, SECURE_MODE);
          }
        } catch {
          // File may have been removed between the event firing and our chmod;
          // race is benign. Do not log — would spam during active sessions.
        }
      },
    );
    watcher.on('error', (err) => {
      logger.warn({ err, authDir }, 'auth-permissions: watcher error');
    });
  } catch (err) {
    logger.warn(
      { err, authDir },
      'auth-permissions: fs.watch unavailable; live tightening disabled (initial walk still applied)',
    );
  }
}
