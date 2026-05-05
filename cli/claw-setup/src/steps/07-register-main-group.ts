import fs from 'fs';
import path from 'path';
import * as clack from '@clack/prompts';
import Database from 'better-sqlite3';
import type { Step } from '../types.js';

interface ChatRow {
  jid: string;
  name?: string | null;
}

export const step: Step = {
  id: '07-register-main-group',
  title: 'Register main WhatsApp group',

  async check(state) {
    if (state.completedSteps.includes('07-register-main-group')) {
      return { done: true, reason: 'main group already registered' };
    }
    if (state.profile === 'hobbyist') {
      return { done: true, reason: 'hobbyist profile — no real group to register' };
    }
    return { done: false };
  },

  async execute(state, ui) {
    if (state.data['__dry_run'] === true) {
      ui.warn('--dry-run set: skipping group registration.');
      return {};
    }

    const orchRoot = process.cwd();
    const dbPath = path.join(orchRoot, 'store', 'messages.db');
    if (!fs.existsSync(dbPath)) {
      ui.error(`messages.db not found at ${dbPath}. Has the orchestrator started at least once?`);
      throw new Error('messages.db missing');
    }

    let db: Database.Database;
    try {
      db = new Database(dbPath, { readonly: false });
    } catch (err: any) {
      ui.error(`failed to open ${dbPath}: ${err?.message ?? err}`);
      throw err;
    }

    // List groups
    let chats: ChatRow[];
    try {
      chats = db.prepare("SELECT jid, name FROM chats WHERE jid LIKE '%@g.us'").all() as ChatRow[];
    } catch (err: any) {
      db.close();
      ui.error(`could not query chats: ${err?.message ?? err}`);
      throw err;
    }

    if (chats.length === 0) {
      db.close();
      ui.warn('No WhatsApp groups found in messages.db. Send a message to your intended main group first, then resume.');
      return { warning: 'no groups available yet' };
    }

    const choice = await clack.select({
      message: 'Which WhatsApp group should be your main control group?',
      options: chats.map((c) => ({
        value: c.jid,
        label: c.name ?? c.jid,
        hint: c.jid,
      })),
    });
    if (clack.isCancel(choice)) {
      db.close();
      throw new Error('Group selection cancelled');
    }

    const jid = choice as string;

    // Ensure registered_groups table exists. We don't create the schema here —
    // the orchestrator owns it. If it's missing, surface the error.
    const containerConfig = JSON.stringify({
      model: 'claude-sonnet-4-5',
      agentProfile: 'main',
    });

    try {
      db.prepare(
        `INSERT OR REPLACE INTO registered_groups
          (jid, is_main, requires_trigger, containerConfig)
         VALUES (?, 1, 1, ?)`,
      ).run(jid, containerConfig);
    } catch (err: any) {
      db.close();
      ui.error(`failed to insert into registered_groups: ${err?.message ?? err}`);
      throw err;
    }

    db.close();
    ui.success(`Registered ${jid} as main group`);
    return { data: { main_jid: jid } };
  },

  async verify(state) {
    if (state.profile === 'hobbyist' || state.data['__dry_run'] === true) {
      return { ok: true, details: 'skipped for this profile / dry-run' };
    }
    return state.data['main_jid']
      ? { ok: true, details: `main_jid=${state.data['main_jid']}` }
      : { ok: false, details: 'no main_jid recorded' };
  },
};
