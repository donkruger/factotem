/**
 * X Integration - File-based lock
 *
 * Prevents concurrent access to shared resources like the Chrome
 * browser profile. Uses atomic file operations — no external deps.
 */

import fs from 'fs';
import path from 'path';
import { config } from './config.js';

const LOCK_DIR = path.join(config.browserDataDir, '..'); // data/ directory
const STALE_THRESHOLD_MS = 180000; // 3 minutes — matches x-handler timeout

/**
 * Acquire a named lock. Returns true if acquired, false if already held.
 * Stale locks (older than 3 minutes) are automatically cleaned up.
 */
export function acquireLock(name: string): boolean {
  const lockPath = path.join(LOCK_DIR, `${name}.lock`);

  // Check for stale lock
  if (fs.existsSync(lockPath)) {
    try {
      const stat = fs.statSync(lockPath);
      if (Date.now() - stat.mtimeMs > STALE_THRESHOLD_MS) {
        fs.unlinkSync(lockPath);
      } else {
        return false;
      }
    } catch {
      // Race condition — another process cleaned it up
    }
  }

  try {
    // O_EXCL ensures atomic creation — fails if file already exists
    fs.writeFileSync(lockPath, String(process.pid), { flag: 'wx' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Release a named lock.
 */
export function releaseLock(name: string): void {
  const lockPath = path.join(LOCK_DIR, `${name}.lock`);
  try {
    fs.unlinkSync(lockPath);
  } catch {
    // Already released or never acquired
  }
}
