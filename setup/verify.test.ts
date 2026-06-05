import fs from 'fs';
import os from 'os';
import path from 'path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  dbErrorHint,
  isAbiMismatch,
  readRegisteredGroupCount,
} from './db-probe.js';
import { decideVerifyStatus } from './verify.js';

/**
 * Regression tests for the registered-groups probe and the overall-status
 * gate. The bug these guard: a *failed* DB read (e.g. a better-sqlite3 ABI
 * mismatch) was swallowed and reported as "0 groups", forcing STATUS=failed on
 * a healthy install. A read failure must be reported as UNKNOWN (count: null),
 * never as zero, and must not by itself fail the deployment.
 */

describe('decideVerifyStatus — overall status gate', () => {
  const healthy = {
    service: 'running',
    credentials: 'configured',
    anyChannelConfigured: true,
  };

  it('succeeds when everything is healthy and groups exist', () => {
    expect(decideVerifyStatus({ ...healthy, groupCount: 5 })).toBe('success');
  });

  it('does NOT fail solely because the group count is unknown (DB read error)', () => {
    // The core ask: an unreadable DB on an otherwise-healthy deployment must
    // stay 'success'. Unknown (null) is non-blocking.
    expect(decideVerifyStatus({ ...healthy, groupCount: null })).toBe(
      'success',
    );
  });

  it('fails on a KNOWN zero group count (genuinely incomplete setup)', () => {
    expect(decideVerifyStatus({ ...healthy, groupCount: 0 })).toBe('failed');
  });

  it('still fails for real problems even when groups are unknown', () => {
    expect(
      decideVerifyStatus({ ...healthy, service: 'stopped', groupCount: null }),
    ).toBe('failed');
    expect(
      decideVerifyStatus({
        ...healthy,
        credentials: 'missing',
        groupCount: null,
      }),
    ).toBe('failed');
    expect(
      decideVerifyStatus({
        ...healthy,
        anyChannelConfigured: false,
        groupCount: 5,
      }),
    ).toBe('failed');
  });
});

describe('readRegisteredGroupCount — read vs zero vs unknown', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-verify-'));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeDb(rows: number): string {
    const dbPath = path.join(tmpDir, 'messages.db');
    const db = new Database(dbPath);
    db.exec(`CREATE TABLE registered_groups (
      jid TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      folder TEXT NOT NULL UNIQUE,
      trigger_pattern TEXT NOT NULL,
      added_at TEXT NOT NULL,
      requires_trigger INTEGER DEFAULT 1
    )`);
    const insert = db.prepare(
      `INSERT INTO registered_groups (jid, name, folder, trigger_pattern, added_at, requires_trigger)
       VALUES (?, ?, ?, ?, ?, 1)`,
    );
    for (let i = 0; i < rows; i++) {
      insert.run(`${i}@g.us`, `Group ${i}`, `group-${i}`, '@Andy', '2026-01-01');
    }
    db.close();
    return dbPath;
  }

  it('returns 0 with no error when the DB file is absent (fresh install)', () => {
    const result = readRegisteredGroupCount(
      path.join(tmpDir, 'does-not-exist.db'),
    );
    expect(result).toEqual({ count: 0, error: null });
  });

  it('returns the real count when the DB reads cleanly', () => {
    const result = readRegisteredGroupCount(makeDb(3));
    expect(result).toEqual({ count: 3, error: null });
  });

  it('returns a genuine 0 (not unknown) for an empty table', () => {
    const result = readRegisteredGroupCount(makeDb(0));
    expect(result).toEqual({ count: 0, error: null });
  });

  it('returns count:null + error (NOT 0) when the DB cannot be read', () => {
    // Simulate a read failure: a file that exists but is not a SQLite DB.
    // This is the branch that an ABI mismatch also takes — the point is that a
    // throw never masquerades as "0 groups".
    const garbage = path.join(tmpDir, 'messages.db');
    fs.writeFileSync(garbage, 'this is not a sqlite database\n');
    const result = readRegisteredGroupCount(garbage);
    expect(result.count).toBeNull();
    expect(result.error).toBeTruthy();
    // Error must be single-line so it survives the KEY: value status block.
    expect(result.error).not.toContain('\n');
  });
});

describe('isAbiMismatch / dbErrorHint', () => {
  const abiMessage =
    "The module '/x/better_sqlite3.node' was compiled against a different " +
    'Node.js version using NODE_MODULE_VERSION 141. This version of Node.js ' +
    'requires NODE_MODULE_VERSION 127.';

  it('detects a NODE_MODULE_VERSION ABI mismatch', () => {
    expect(isAbiMismatch(abiMessage)).toBe(true);
    expect(isAbiMismatch('disk I/O error')).toBe(false);
  });

  it('gives ABI-specific, actionable guidance for a mismatch', () => {
    const hint = dbErrorHint(abiMessage);
    expect(hint).toMatch(/different Node\.js/);
    expect(hint).toMatch(/npm rebuild better-sqlite3/);
  });

  it('gives a generic log pointer for other errors', () => {
    const hint = dbErrorHint('database disk image is malformed');
    expect(hint).toMatch(/logs\/setup\.log/);
  });
});
