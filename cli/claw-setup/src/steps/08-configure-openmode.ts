import fs from 'fs';
import path from 'path';
import * as clack from '@clack/prompts';
import Database from 'better-sqlite3';
import type { Step } from '../types.js';

export const step: Step = {
  id: '08-configure-openmode',
  title: 'Configure OpenMode (optional)',

  async check(state) {
    if (state.completedSteps.includes('08-configure-openmode')) {
      return { done: true, reason: 'already configured' };
    }
    if (state.profile === 'hobbyist') {
      return { done: true, reason: 'hobbyist profile — OpenMode not relevant' };
    }
    return { done: false };
  },

  async execute(state, ui) {
    if (state.data['__dry_run'] === true) {
      ui.warn('--dry-run set: skipping OpenMode prompt.');
      return {};
    }

    const enable = await clack.confirm({
      message:
        'Enable OpenMode for the main group? (Off by default — gives the agent budgeted authority to act without per-message confirmation.)',
      initialValue: false,
    });
    if (clack.isCancel(enable) || !enable) {
      return {};
    }

    const budgetText = await clack.text({
      message: 'Daily budget for OpenMode in cents (e.g. 500 for $5/day):',
      initialValue: '500',
      validate: (v) => {
        const n = Number(v);
        if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) {
          return 'Enter a positive integer.';
        }
        return undefined;
      },
    });
    if (clack.isCancel(budgetText)) {
      return {};
    }
    const budgetCents = Number(budgetText);

    const mainJid = state.data['main_jid'] as string | undefined;
    if (!mainJid) {
      ui.warn('No main_jid recorded; cannot patch containerConfig.');
      return {};
    }

    const dbPath = path.join(process.cwd(), 'store', 'messages.db');
    if (!fs.existsSync(dbPath)) {
      ui.warn(`messages.db not found at ${dbPath}; skipping.`);
      return {};
    }

    const db = new Database(dbPath, { readonly: false });
    try {
      const row = db
        .prepare('SELECT containerConfig FROM registered_groups WHERE jid = ?')
        .get(mainJid) as { containerConfig?: string } | undefined;
      if (!row) {
        ui.warn(`registered_groups row for ${mainJid} not found.`);
        return {};
      }
      const parsed = row.containerConfig ? JSON.parse(row.containerConfig) : {};
      parsed.openMode = { enabled: true, dailyBudgetCents: budgetCents };
      db.prepare('UPDATE registered_groups SET containerConfig = ? WHERE jid = ?').run(
        JSON.stringify(parsed),
        mainJid,
      );
      ui.success(`OpenMode enabled for ${mainJid} with daily budget ${budgetCents}c`);
    } finally {
      db.close();
    }

    return { data: { open_mode: { enabled: true, dailyBudgetCents: budgetCents } } };
  },

  async verify(_state) {
    return { ok: true, details: 'OpenMode step complete (optional, may be off)' };
  },
};
