import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import * as clack from '@clack/prompts';
import Database from 'better-sqlite3';
import type { Step } from '../types.js';

interface ChatRow {
  jid: string;
  name: string | null;
}

// W.1 (2026-05-08) — Step 07 now runs AFTER the orchestrator is live
// (step 09 bootstrapped launchd). That eliminates the brittle two-process
// Baileys race the old version had — we no longer spin up our own
// `setup --step groups` Baileys socket while the orchestrator owns the
// auth state. Instead we read the chats table the orchestrator's WhatsApp
// channel populates as messages flow in, prompt the operator to pick
// one, register it via `setup --step register`, then SIGHUP the live
// orchestrator to reload `registered_groups` without a launchctl restart.
//
// Reused primitives:
//   - `setup --step register` (setup/register.ts) — writes the row
//     with all NOT NULL columns + `--trigger`, `--assistant-name`.
//   - `process.kill(pid, 'SIGHUP')` via `kill -HUP <pid>` — caught by
//     src/index.ts:1084's SIGHUP handler which reloads from DB.
//   - /health endpoint — used to confirm the orchestrator is alive.
//   - pgrep -f 'dist/index.js' — fallback when /health doesn't bind
//     (we expect this to return one PID; if not, we surface a clear
//     warning so operators can investigate).

const HEALTH_URL = 'http://localhost:7842/health';
const ORCHESTRATOR_WAIT_TIMEOUT_MS = 30_000;
const ORCHESTRATOR_WAIT_INTERVAL_MS = 2_000;
const GROUP_POLL_TIMEOUT_MS = 90_000;
const GROUP_POLL_INTERVAL_MS = 5_000;

function readGroupChats(dbPath: string): ChatRow[] {
  if (!fs.existsSync(dbPath)) return [];
  const db = new Database(dbPath, { readonly: true });
  try {
    return db
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

function findOrchestratorPid(): number | null {
  try {
    const out = execSync("pgrep -f 'dist/index.js'", { encoding: 'utf8' });
    const lines = out
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => /^\d+$/.test(l));
    if (lines.length === 0) return null;
    // If multiple PIDs match, take the first — pgrep returns parent
    // before children. The orchestrator is a single Node process so
    // we generally expect exactly one match.
    return parseInt(lines[0], 10);
  } catch {
    return null;
  }
}

async function waitForOrchestrator(
  ui: { runCommand: (c: string, a: string[]) => Promise<{ code: number; stdout: string; stderr: string }> },
): Promise<{ ok: boolean; via: 'health' | 'pgrep' | 'none' }> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < ORCHESTRATOR_WAIT_TIMEOUT_MS) {
    // Prefer /health — definitive signal the HTTP server is bound and
    // the orchestrator is fully initialised. Fall back to pgrep so the
    // wizard works on machines where /health hasn't been fixed yet
    // (W.1.D addresses /health binding separately).
    const health = await ui.runCommand('curl', [
      '-sf',
      '-o',
      '/dev/null',
      HEALTH_URL,
    ]);
    if (health.code === 0) return { ok: true, via: 'health' };
    if (findOrchestratorPid() !== null) return { ok: true, via: 'pgrep' };
    await new Promise((resolve) => setTimeout(resolve, ORCHESTRATOR_WAIT_INTERVAL_MS));
  }
  return { ok: false, via: 'none' };
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
    const assistantName =
      typeof state.assistantName === 'string' && state.assistantName.length > 0
        ? state.assistantName
        : 'Andy';
    const trigger = `@${assistantName}`;

    // 1. Wait for the orchestrator to be alive. Step 09 bootstrapped
    // launchd just before this step ran; the orchestrator typically
    // takes 5-15s to bind /health.
    ui.note(
      'Waiting for orchestrator',
      `Polling ${HEALTH_URL} for up to ${ORCHESTRATOR_WAIT_TIMEOUT_MS / 1000}s.\n` +
        'On first bootstrap, NanoClaw needs ~5-15s to bind the dashboard\n' +
        'port and connect WhatsApp. Group registration runs against the\n' +
        'live orchestrator (no separate Baileys socket).',
    );
    const live = await waitForOrchestrator(ui);
    if (!live.ok) {
      ui.warn(
        'Orchestrator did not respond within timeout. The wizard cannot\n' +
          'register a group without the live orchestrator (the chats table\n' +
          'is populated by the orchestrator\'s WhatsApp channel).\n\n' +
          'Inspect with:\n' +
          '  launchctl print gui/$(id -u)/com.nanoclaw\n' +
          '  tail -f logs/nanoclaw.log\n\n' +
          'Re-run the wizard with `npm run claw-setup -- --resume` once it\'s up.',
      );
      return {
        data: { main_group_deferred: true },
        warning: 'orchestrator not reachable',
      };
    }
    ui.success(`Orchestrator alive (via ${live.via}).`);

    // 2. Read the chats table. If empty, guide the operator to send a
    // message in the group they want as main, then poll until at least
    // one row appears.
    let chats = readGroupChats(dbPath);

    if (chats.length === 0) {
      ui.note(
        'Send a message',
        'No WhatsApp groups have appeared in the orchestrator\'s chats table\n' +
          'yet. To register your main control group:\n\n' +
          '  1. On your phone, open the WhatsApp group you want to use\n' +
          '     (or create a new one — make sure your account is a member).\n' +
          '  2. Send any message in that group.\n' +
          '  3. The orchestrator will pick it up within a few seconds.\n\n' +
          `The wizard will poll every ${GROUP_POLL_INTERVAL_MS / 1000}s for up to ` +
          `${GROUP_POLL_TIMEOUT_MS / 1000}s and pick up new groups automatically.`,
      );

      const startedAt = Date.now();
      let lastReportedCount = 0;
      const totalSecs = Math.round(GROUP_POLL_TIMEOUT_MS / 1000);
      while (Date.now() - startedAt < GROUP_POLL_TIMEOUT_MS) {
        await new Promise((resolve) => setTimeout(resolve, GROUP_POLL_INTERVAL_MS));
        chats = readGroupChats(dbPath);
        const elapsed = Math.round((Date.now() - startedAt) / 1000);
        const remaining = Math.max(0, totalSecs - elapsed);
        if (chats.length !== lastReportedCount) {
          // Group count changed — definitive progress signal.
          process.stdout.write(
            `  · ${chats.length} group(s) visible (${elapsed}s elapsed, ${remaining}s remaining)\n`,
          );
          lastReportedCount = chats.length;
        } else {
          // No new groups yet — still emit a tick so the operator sees the
          // wizard is alive and tracking time. Lighter dot variant.
          process.stdout.write(
            `  · waiting for groups… (${elapsed}s elapsed, ${remaining}s remaining)\n`,
          );
        }
        if (chats.length > 0) break;
      }

      if (chats.length === 0) {
        ui.warn(
          `No WhatsApp groups appeared within ${GROUP_POLL_TIMEOUT_MS / 1000}s.\n` +
            'Marking step deferred — re-run the wizard later once a message\n' +
            'has been sent in the group:\n' +
            '  npm run claw-setup -- --resume',
        );
        return {
          data: { main_group_deferred: true },
          warning: 'no groups visible to orchestrator within timeout',
        };
      }
    }

    ui.success(`Found ${chats.length} WhatsApp group(s).`);

    // 3. Operator picks one.
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
    // Uses the persona name from state — `--trigger '@Sarah'` not '@Andy'.
    // `--assistant-name` is also passed so the registered_groups row's
    // assistant_name column reflects the persona (used by the agent's
    // signature line generation).
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
      '--trigger',
      trigger,
      '--assistant-name',
      assistantName,
      '--is-main',
    ]);
    if (registerResult.code !== 0) {
      ui.error(
        `setup --step register failed (exit ${registerResult.code}). stderr: ${registerResult.stderr.slice(-400)}`,
      );
      throw new Error('group registration failed');
    }

    // 5. Hot-reload the live orchestrator's registered_groups via SIGHUP.
    // src/index.ts:1084 catches SIGHUP and re-reads from DB. Without this,
    // the orchestrator wouldn't see the new registration until the next
    // launchctl restart, and inbound messages to the just-registered
    // group would be dropped with `registeredJids: [...]` not including
    // the new JID.
    const pid = findOrchestratorPid();
    if (pid !== null) {
      try {
        process.kill(pid, 'SIGHUP');
        ui.success(`Sent SIGHUP to orchestrator (pid ${pid}) to reload registered_groups.`);
      } catch (err) {
        ui.warn(
          `Sent SIGHUP failed: ${(err as Error).message}. The orchestrator will pick up\n` +
            'the new registration on next restart, but messages to this group\n' +
            'may be dropped until then. Manual reload:\n' +
            `  kill -HUP ${pid}`,
        );
      }
    } else {
      ui.warn(
        'Could not find orchestrator PID via pgrep — registration written to DB,\n' +
          'but the live orchestrator may not pick it up until next restart. If\n' +
          'messages aren\'t reaching the agent, run:\n' +
          '  launchctl kickstart -k gui/$(id -u)/com.nanoclaw',
      );
    }

    ui.success(`Registered ${selectedName} (${jid}) as the main group with trigger ${trigger}`);
    return { data: { main_jid: jid, main_name: selectedName } };
  },

  async verify(state) {
    if (state.profile === 'hobbyist' || state.data['__dry_run'] === true) {
      return { ok: true, details: 'skipped for this profile / dry-run' };
    }
    if (state.data['main_group_deferred'] === true) {
      return { ok: true, details: 'deferred — re-run once orchestrator + group are ready' };
    }
    return state.data['main_jid']
      ? { ok: true, details: `main_jid=${state.data['main_jid']}` }
      : { ok: false, details: 'no main_jid recorded' };
  },
};
