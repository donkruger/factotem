import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import type { Step } from '../types.js';

// Wraps `src/whatsapp-auth.ts` — the orchestrator's existing pairing
// script. That script displays a QR code (via qrcode-terminal),
// optionally accepts a phone number for pairing-code mode, and writes
// store/auth/creds.json + store/auth/* keys when pairing succeeds.
// The script is interactive — it needs stdio inheritance so the
// operator can see the QR and respond to readline prompts.

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

    // Tell the operator what's about to happen. The next ~30s of
    // terminal output belongs to the auth script — it'll render a
    // QR code that's much bigger than this wizard's clack frames.
    ui.note(
      'WhatsApp pairing',
      'A QR code will appear in this terminal in a moment.\n' +
        '1. Open WhatsApp on your phone\n' +
        '2. Settings → Linked Devices → Link a Device\n' +
        '3. Scan the QR code that appears here\n' +
        '4. Wait for "✓ Authenticated" — pairing typically takes 5–15 seconds\n' +
        '5. The wizard will resume after the auth script exits',
    );

    // Spawn the existing whatsapp-auth.ts entrypoint with stdio
    // inheritance so the QR code renders in the operator's terminal
    // and readline prompts work. We can't use ui.runCommand here
    // because that buffers stdout — the QR would never appear.
    const orchRoot = process.cwd();
    const authScript = path.join(orchRoot, 'src', 'whatsapp-auth.ts');
    if (!fs.existsSync(authScript)) {
      ui.error(`whatsapp-auth.ts not found at ${authScript}`);
      throw new Error('whatsapp-auth.ts missing');
    }

    const exitCode: number = await new Promise((resolve) => {
      const child = spawn('npx', ['tsx', authScript], {
        stdio: 'inherit',
        cwd: orchRoot,
      });
      child.on('error', (err) => {
        ui.error(`whatsapp-auth spawn failed: ${err.message}`);
        resolve(-1);
      });
      child.on('close', (code) => {
        resolve(code ?? 0);
      });
    });

    if (exitCode !== 0) {
      ui.error(`whatsapp-auth exited with code ${exitCode}.`);
      throw new Error('whatsapp-auth failed');
    }

    return {};
  },

  async verify(state) {
    if (state.profile === 'hobbyist' || state.data['__dry_run'] === true) {
      return { ok: true, details: 'pairing skipped for this profile / dry-run' };
    }
    const credsPath = path.join(process.cwd(), 'store', 'auth', 'creds.json');
    if (fs.existsSync(credsPath)) {
      return { ok: true, details: 'creds.json present' };
    }
    return { ok: false, details: 'creds.json missing — pairing did not complete' };
  },
};
