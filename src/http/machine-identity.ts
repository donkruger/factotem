/**
 * Per-machine identity for federation-readiness.
 *
 * NanoClaw is single-tenant per host. v2 (federation) will aggregate
 * `/health` from multiple machines via Tailscale. To make that possible
 * without a v1→v2 architectural rewrite, every NanoClaw deployment
 * carries a stable `machine.json` identity from day one (T-1778233000000).
 *
 * Stored at `~/.config/nanoclaw/machine.json` (outside `~/Documents/` so
 * it's reachable from launchd context per the 2026-04-24 TCC ben-log
 * lesson). File permissions are 0o600.
 */

import { randomUUID } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { logger } from '../logger.js';

const HOME_DIR = os.homedir();
const CONFIG_DIR = path.join(HOME_DIR, '.config', 'nanoclaw');
const MACHINE_JSON_PATH = path.join(CONFIG_DIR, 'machine.json');

const DEFAULT_BRAIN_PATH =
  '/Users/support/Library/CloudStorage/GoogleDrive-don.kruger123@gmail.com/My Drive/Ben Brain';

export interface MachineIdentity {
  id: string;
  hostname: string;
  region: string;
  brain_path: string;
  created_at: string;
}

let cached: MachineIdentity | undefined;

/**
 * Read or initialise the machine identity. Auto-creates the file on
 * first call with a UUID v4, the host's `os.hostname()`, region "Local",
 * and the operator's known Brain path (per Q9 — promotes from
 * hardcoded constant in `kp.ts` to a configurable field).
 *
 * Returns the cached value on subsequent calls (file is read-once at
 * process startup). Re-pairing the host requires a NanoClaw restart to
 * pick up a new identity.
 */
export function getMachineIdentity(): MachineIdentity {
  if (cached) return cached;
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    if (fs.existsSync(MACHINE_JSON_PATH)) {
      const raw = fs.readFileSync(MACHINE_JSON_PATH, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<MachineIdentity>;
      // Backfill any missing fields onto an existing file (forward-compat)
      const identity: MachineIdentity = {
        id: parsed.id ?? randomUUID(),
        hostname: parsed.hostname ?? os.hostname(),
        region: parsed.region ?? 'Local',
        brain_path: parsed.brain_path ?? DEFAULT_BRAIN_PATH,
        created_at: parsed.created_at ?? new Date().toISOString(),
      };
      // If we filled any missing fields, persist the augmented file
      if (
        !parsed.id ||
        !parsed.hostname ||
        !parsed.region ||
        !parsed.brain_path ||
        !parsed.created_at
      ) {
        writeIdentity(identity);
      }
      cached = identity;
      return identity;
    }
    // First-run: create
    const identity: MachineIdentity = {
      id: randomUUID(),
      hostname: os.hostname(),
      region: 'Local',
      brain_path: DEFAULT_BRAIN_PATH,
      created_at: new Date().toISOString(),
    };
    writeIdentity(identity);
    logger.info(
      { id: identity.id, hostname: identity.hostname },
      'machine-identity: created new machine.json',
    );
    cached = identity;
    return identity;
  } catch (err) {
    logger.warn(
      { err },
      'machine-identity: failed to read/write machine.json; using ephemeral identity',
    );
    // Don't crash the process — return an ephemeral identity for this run
    cached = {
      id: 'ephemeral-' + randomUUID(),
      hostname: os.hostname(),
      region: 'Local',
      brain_path: DEFAULT_BRAIN_PATH,
      created_at: new Date().toISOString(),
    };
    return cached;
  }
}

function writeIdentity(identity: MachineIdentity): void {
  fs.writeFileSync(MACHINE_JSON_PATH, JSON.stringify(identity, null, 2) + '\n');
  fs.chmodSync(MACHINE_JSON_PATH, 0o600);
}
