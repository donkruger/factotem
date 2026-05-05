import fs from 'fs';
import path from 'path';
import type { Step } from '../types.js';

// TODO: live test on next clean deployment. The pairing flow needs to:
//   1. Spawn the orchestrator briefly to start the WhatsApp socket
//   2. Capture pairing code from logs (or display QR via qrcode-terminal)
//   3. Wait for the operator to scan/pair
//   4. Verify creds.json was written
// We cannot fully implement and test this step against a live system without
// disrupting Don's existing pairing — so the framework is in place but the
// active pairing is a placeholder. Don's live deployment must use the existing
// `npx tsx src/whatsapp-auth.ts` flow until this step is exercised on a clean
// host.

export const step: Step = {
  id: '06-pair-whatsapp',
  title: 'Pair WhatsApp account',

  async check(state) {
    if (state.completedSteps.includes('06-pair-whatsapp')) {
      return { done: true, reason: 'previously paired' };
    }
    if (state.profile === 'hobbyist') {
      return { done: true, reason: 'hobbyist profile — local-echo skips real pairing' };
    }
    const credsPath = path.join(process.cwd(), 'store', 'auth', 'creds.json');
    if (fs.existsSync(credsPath) && state.data['__force_pair'] !== true) {
      return { done: true, reason: 'creds.json already present and --force not set' };
    }
    return { done: false };
  },

  async execute(state, ui) {
    if (state.data['__dry_run'] === true) {
      ui.warn('--dry-run set: skipping WhatsApp pairing.');
      return {};
    }

    // Defense-in-depth: refuse if creds exist and --force not set.
    const credsPath = path.join(process.cwd(), 'store', 'auth', 'creds.json');
    if (fs.existsSync(credsPath) && state.data['__force_pair'] !== true) {
      ui.error(
        'Existing WhatsApp credentials detected. Pass --force to wipe and re-pair.',
      );
      throw new Error('refusing to pair over existing creds.json');
    }

    // TODO: live test on next clean deployment.
    ui.warn(
      'WhatsApp pairing is a stub in this wizard release. Use `npx tsx src/whatsapp-auth.ts` until this step is exercised on a clean host.',
    );

    return {};
  },

  async verify(state) {
    if (state.profile === 'hobbyist' || state.data['__dry_run'] === true) {
      return { ok: true, details: 'pairing skipped for this profile / dry-run' };
    }
    // For now: just check creds.json exists. Live-pairing logic is the TODO above.
    const credsPath = path.join(process.cwd(), 'store', 'auth', 'creds.json');
    if (fs.existsSync(credsPath)) {
      return { ok: true, details: 'creds.json present' };
    }
    return { ok: false, details: 'creds.json missing — pairing did not complete' };
  },
};
