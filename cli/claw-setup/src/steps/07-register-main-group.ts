import fs from 'fs';
import path from 'path';
import * as clack from '@clack/prompts';
import Database from 'better-sqlite3';
import type { Step } from '../types.js';

interface ChatRow {
  jid: string;
  name: string | null;
}

// Wraps the orchestrator's two existing setup primitives:
//
//   setup --step groups           Builds the orchestrator's TS (so dist/
//                                 exists), starts a temp Baileys socket,
//                                 fetches every WhatsApp group the
//                                 operator is in via groupFetchAllParticipating,
//                                 writes them to the chats table.
//                                 Idempotent.
//
//   setup --step register --jid X --name Y --folder main --is-main \
//                       --channel whatsapp [--trigger @Andy]
//                                 Inserts a row into registered_groups
//                                 with all NOT NULL columns populated.
//
// Both primitives call src/db.ts's initDatabase() which creates the
// schema if missing — so step 07 doesn't need to do that itself.
//
// Previously step 07 tried to do this work inline and had two bugs:
//   1. No DB-create path (failed when messages.db was absent).
//   2. INSERT used `containerConfig` (camelCase) instead of
//      `container_config` (snake_case per schema), AND omitted the
//      NOT NULL columns name / folder / trigger_pattern / added_at.
// Wrapping the existing primitives is correct because the orchestrator
// owns the schema; the wizard shouldn't reimplement schema knowledge.

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

    // 1. Sync WhatsApp groups via Baileys. The orchestrator's
    // setup --step groups command builds TS first (~30-60s) then
    // briefly spins up a Baileys socket to call groupFetchAllParticipating
    // and writes results to chats. Side-effect: messages.db is
    // created if absent (initDatabase is called).
    ui.note(
      'Syncing WhatsApp groups',
      'Briefly connecting to WhatsApp via Baileys to fetch the groups your\n' +
        'paired account is a member of. Takes ~30–60s (TS build + socket\n' +
        'connect + group fetch).',
    );

    const startedSync = Date.now();
    const heartbeatSync = setInterval(() => {
      const secs = Math.round((Date.now() - startedSync) / 1000);
      process.stdout.write(`  · still syncing… (${secs}s elapsed)\n`);
    }, 15_000);

    let syncResult;
    try {
      syncResult = await ui.runCommand('npx', [
        'tsx',
        path.join(orchRoot, 'setup', 'index.ts'),
        '--step',
        'groups',
      ]);
    } finally {
      clearInterval(heartbeatSync);
    }
    if (syncResult.code !== 0) {
      ui.error(
        `setup --step groups failed (exit ${syncResult.code}). stderr: ${syncResult.stderr.slice(-400)}`,
      );
      throw new Error('group sync failed');
    }

    // 2. Read synced groups directly from the DB.
    const dbPath = path.join(orchRoot, 'store', 'messages.db');
    if (!fs.existsSync(dbPath)) {
      ui.error(`messages.db still not found at ${dbPath} after sync.`);
      throw new Error('messages.db missing after sync');
    }

    const db = new Database(dbPath, { readonly: true });
    let chats: ChatRow[];
    try {
      chats = db
        .prepare(
          "SELECT jid, name FROM chats " +
            "WHERE jid LIKE '%@g.us' " +
            "AND jid <> '__group_sync__' " +
            "AND name IS NOT NULL " +
            'ORDER BY last_message_time DESC',
        )
        .all() as ChatRow[];
    } finally {
      db.close();
    }

    if (chats.length === 0) {
      ui.warn(
        'WhatsApp group sync returned zero groups. Either you\'re not in any\n' +
          'groups on the paired account, or the sync didn\'t pick them up.\n' +
          'Add the paired number to your intended main group on WhatsApp,\n' +
          'then resume the wizard.',
      );
      return { warning: 'no groups available yet — resume after adding to a group' };
    }

    // 3. Prompt operator to pick a group.
    const choice = await clack.select({
      message: 'Which WhatsApp group should be your main control group?',
      options: chats.map((c) => ({
        value: c.jid,
        label: c.name ?? c.jid,
        hint: c.jid,
      })),
    });
    if (clack.isCancel(choice)) {
      throw new Error('Group selection cancelled');
    }
    const jid = choice as string;
    const selectedName = chats.find((c) => c.jid === jid)?.name ?? jid;

    // 4. Register via the orchestrator's setup --step register primitive.
    // It writes the proper schema with all NOT NULL columns and calls
    // initDatabase() for safety.
    const registerResult = await ui.runCommand('npx', [
      'tsx',
      path.join(orchRoot, 'setup', 'index.ts'),
      '--step',
      'register',
      '--',
      '--jid',
      jid,
      '--name',
      selectedName,
      '--folder',
      'main',
      '--channel',
      'whatsapp',
      '--is-main',
    ]);
    if (registerResult.code !== 0) {
      ui.error(
        `setup --step register failed (exit ${registerResult.code}). stderr: ${registerResult.stderr.slice(-400)}`,
      );
      throw new Error('group registration failed');
    }

    ui.success(`Registered ${selectedName} (${jid}) as the main group`);
    return { data: { main_jid: jid, main_name: selectedName } };
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
