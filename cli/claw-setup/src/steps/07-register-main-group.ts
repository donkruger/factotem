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
    // setup --step groups command builds TS, spins up a Baileys
    // socket (using the auth state from step 06), calls
    // groupFetchAllParticipating, writes to chats. Calls
    // initDatabase() so messages.db is created if absent.
    //
    // Fresh Baileys pairings sometimes need a few minutes to
    // settle before group sync returns reliably — we retry up to
    // three times with 30-second pauses. If the sync succeeds but
    // returns zero groups (operator's account isn't in any
    // WhatsApp groups yet), we guide them to join one and retry.
    let chats: ChatRow[] = [];
    const MAX_SYNC_ATTEMPTS = 3;

    for (let attempt = 1; attempt <= MAX_SYNC_ATTEMPTS; attempt++) {
      ui.note(
        attempt === 1
          ? 'Syncing WhatsApp groups'
          : `Syncing WhatsApp groups (attempt ${attempt}/${MAX_SYNC_ATTEMPTS})`,
        'Briefly connecting to WhatsApp via Baileys to fetch the groups your\n' +
          'paired account is a member of. Takes 30–120s (TS build + socket\n' +
          'connect + group fetch).',
      );

      const startedSync = Date.now();
      const heartbeatSync = setInterval(() => {
        const secs = Math.round((Date.now() - startedSync) / 1000);
        process.stdout.write(`  · still syncing… (${secs}s elapsed)\n`);
      }, 20_000);

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

      const syncOk = syncResult.code === 0;
      const dbPath = path.join(orchRoot, 'store', 'messages.db');

      if (syncOk && fs.existsSync(dbPath)) {
        const db = new Database(dbPath, { readonly: true });
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
      }

      if (chats.length > 0) {
        ui.success(`Found ${chats.length} WhatsApp group(s).`);
        break;
      }

      // Either sync failed OR sync OK but zero groups. Distinct paths.
      if (!syncOk) {
        ui.warn(
          `Sync attempt ${attempt}/${MAX_SYNC_ATTEMPTS} failed (exit ${syncResult.code}).\n` +
            'This is common on fresh WhatsApp pairings — Baileys often needs a\n' +
            'few minutes for the protocol handshake to settle.\n\n' +
            'Last 200 chars of stderr (full output in the setup log):\n' +
            syncResult.stderr.slice(-200),
        );
      } else {
        ui.warn(
          'Sync succeeded but the paired WhatsApp account is not in any groups\n' +
            'yet. To register a main control group:\n' +
            '  1. On your phone, open the WhatsApp group you want to use as\n' +
            '     your main control group (or create a new one).\n' +
            '  2. Make sure your account is a member.\n' +
            '  3. Send any message in that group so it shows up in the\n' +
            '     paired device\'s recent chats.\n' +
            '  4. Confirm below — the wizard will retry.',
        );
      }

      if (attempt < MAX_SYNC_ATTEMPTS) {
        const retry = await clack.confirm({
          message:
            chats.length === 0 && syncOk
              ? "I'm in a group / sent a message — retry sync now?"
              : `Wait 30s and retry the sync? (attempt ${attempt + 1}/${MAX_SYNC_ATTEMPTS})`,
          initialValue: true,
        });
        if (clack.isCancel(retry) || !retry) {
          // Operator chose not to retry.
          ui.warn(
            'Skipping main group registration. Re-run the wizard later with\n' +
              '  npm run claw-setup -- --resume\n' +
              'once your WhatsApp account is in a group.',
          );
          return {
            data: { main_group_deferred: true },
            warning: 'operator declined retry',
          };
        }

        // Wait before retrying (only when sync failed — the zero-groups
        // path doesn't need the wait since the operator just acted).
        if (!syncOk && attempt < MAX_SYNC_ATTEMPTS) {
          await new Promise((resolve) => setTimeout(resolve, 30_000));
        }
      } else {
        // All attempts exhausted.
        ui.warn(
          'All sync attempts exhausted. Marking step deferred — re-run the\n' +
            'wizard later when WhatsApp connectivity is more stable:\n' +
            '  npm run claw-setup -- --resume',
        );
        return {
          data: { main_group_deferred: true },
          warning: 'sync attempts exhausted',
        };
      }
    }

    // chats array is populated at this point.

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
    if (state.data['main_group_deferred'] === true) {
      return { ok: true, details: 'deferred to manual registration after wizard' };
    }
    return state.data['main_jid']
      ? { ok: true, details: `main_jid=${state.data['main_jid']}` }
      : { ok: false, details: 'no main_jid recorded' };
  },
};
