import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import * as clack from '@clack/prompts';
import Database from 'better-sqlite3';
import type { Step } from '../types.js';

// W.1 (2026-05-08) — repurposed from "OpenMode budget gate" to
// "Open DM enabler". The orchestrator's open-mode subsystem
// (src/open-mode.ts + src/index.ts:885) is what auto-onboards
// unsolicited DM senders into per-sender `open_dm` containers, but
// it's gated on `loadOpenMode(registeredGroups)` returning a config
// with `enabled: true`. That config lives on the main group's
// `container_config.openMode` JSON column.
//
// This step writes that JSON via direct SQLite UPDATE (the orchestrator
// already understands the shape) and SIGHUPs the live process so the
// new config takes effect without a launchctl restart.
//
// Schema knowledge intentionally limited to one column — the wizard
// reads/writes container_config and nothing else.
//
// Reused primitives:
//   - src/types.ts OpenModeConfig — the shape we write.
//   - src/index.ts:1084 SIGHUP handler — re-reads registered_groups
//     so the new openMode is picked up by the next message.
//   - pgrep -f 'dist/index.js' — finds the orchestrator's PID.

interface RegisteredGroupRow {
  jid: string;
  name: string;
  container_config: string | null;
  is_main: number;
}

function findMainGroup(dbPath: string): RegisteredGroupRow | null {
  if (!fs.existsSync(dbPath)) return null;
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db
      .prepare(
        'SELECT jid, name, container_config, is_main FROM registered_groups WHERE is_main = 1 LIMIT 1',
      )
      .get() as RegisteredGroupRow | undefined;
    return row ?? null;
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
    return parseInt(lines[0], 10);
  } catch {
    return null;
  }
}

export const step: Step = {
  id: '08-configure-openmode',
  title: 'Enable open-DM mode (auto-onboard direct messages)',

  async check(state) {
    if (state.completedSteps.includes('08-configure-openmode')) {
      return { done: true, reason: 'already configured' };
    }
    if (state.profile === 'hobbyist') {
      return { done: true, reason: 'hobbyist profile — no real DMs to handle' };
    }
    if (state.data['main_group_deferred'] === true) {
      return {
        done: true,
        reason: 'main group registration was deferred; open-DM mode skipped',
      };
    }
    return { done: false };
  },

  async execute(state, ui) {
    if (state.data['__dry_run'] === true) {
      ui.warn('--dry-run set: skipping open-DM configuration.');
      return {};
    }

    const orchRoot = process.cwd();
    const dbPath = path.join(orchRoot, 'store', 'messages.db');

    // 1. Find the main group from the LIVE DB. We don't trust state.data
    // because the wizard may have been resumed across multiple runs, and
    // step 07 only writes main_jid into state on the same-run path.
    const main = findMainGroup(dbPath);
    if (!main) {
      ui.warn(
        'No main group is registered in the orchestrator yet. Skipping open-DM\n' +
          'configuration. Re-run the wizard with `--resume` after registering a\n' +
          'main group via step 07.',
      );
      return {
        data: { open_dm: { enabled: false, reason: 'no_main_group' } },
        warning: 'no main group',
      };
    }

    // 2. Default-Yes confirm. The plan calls for open-DM to be the
    // recommended path for personal-assistant deployments; operators
    // who want the old "registered groups only" behaviour can answer No.
    const enable = await clack.confirm({
      message:
        'Enable open-DM mode? (Recommended.)\n' +
        '  · Allows direct messages to your assistant\'s WhatsApp number\n' +
        '    to spawn agent responses — any sender auto-onboards into a\n' +
        '    per-sender container with isolated memory.\n' +
        '  · Subject to a daily host-side cost cap (you\'ll set it next).\n' +
        '  · Without this, only registered groups receive replies — DMs\n' +
        '    from anyone (including yourself) get dropped silently.',
      initialValue: true,
    });
    if (clack.isCancel(enable)) {
      throw new Error('open-DM configuration cancelled');
    }
    if (!enable) {
      ui.note(
        'Open-DM mode left disabled',
        'You can enable it later by editing the main group\'s container_config\n' +
          'in the dashboard or rerunning this step.',
      );
      return { data: { open_dm: { enabled: false, reason: 'operator_declined' } } };
    }

    // 3. Daily budget. 500 cents = $5/day default — generous enough for
    // personal use, low enough to cap accidental loops.
    const budgetText = await clack.text({
      message: 'Daily budget for open-DM in cents (e.g. 500 for $5/day):',
      initialValue: '500',
      placeholder: '500',
      validate: (v) => {
        const n = Number(v);
        if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) {
          return 'Enter a positive integer.';
        }
        return undefined;
      },
    });
    if (clack.isCancel(budgetText)) {
      throw new Error('open-DM budget cancelled');
    }
    const budgetCents = Number(budgetText);

    // 4. Patch the main group's container_config. Merge — preserve any
    // existing keys (additionalMounts, agentProfile, model, etc.) so we
    // don't trample operator-side edits.
    const parsed: Record<string, unknown> = main.container_config
      ? (JSON.parse(main.container_config) as Record<string, unknown>)
      : {};
    parsed.openMode = {
      enabled: true,
      dailyBudgetCents: budgetCents,
      // Generous default rate limit. 30 invocations / hour with 5-burst.
      // Tight enough that a runaway loop hits the limit fast, loose
      // enough that normal back-and-forth conversation isn't throttled.
      rateLimit: {
        tokensPerHour: 30,
        burstMax: 5,
      },
    };

    const writeDb = new Database(dbPath, { readonly: false });
    try {
      writeDb
        .prepare('UPDATE registered_groups SET container_config = ? WHERE jid = ?')
        .run(JSON.stringify(parsed), main.jid);
    } finally {
      writeDb.close();
    }
    ui.success(
      `Patched main group ${main.name} (${main.jid}) — openMode.enabled=true, ` +
        `dailyBudgetCents=${budgetCents}.`,
    );

    // 5. SIGHUP the orchestrator so it reloads from DB. The next inbound
    // DM will be evaluated against the new openMode and auto-onboarded.
    const pid = findOrchestratorPid();
    if (pid !== null) {
      try {
        process.kill(pid, 'SIGHUP');
        ui.success(`Sent SIGHUP to orchestrator (pid ${pid}) to reload registered_groups.`);
      } catch (err) {
        ui.warn(
          `Sent SIGHUP failed: ${(err as Error).message}. Manual reload:\n` +
            `  kill -HUP ${pid}`,
        );
      }
    } else {
      ui.warn(
        'Could not find orchestrator PID — config written to DB but not yet live.\n' +
          'Restart the orchestrator to activate:\n' +
          '  launchctl kickstart -k gui/$(id -u)/com.nanoclaw',
      );
    }

    return {
      data: {
        open_dm: {
          enabled: true,
          dailyBudgetCents: budgetCents,
          appliedToJid: main.jid,
        },
      },
    };
  },

  async verify(state) {
    const od = state.data['open_dm'] as { enabled?: boolean } | undefined;
    if (!od) return { ok: true, details: 'open-DM step skipped (no main group / hobbyist)' };
    if (od.enabled === true) return { ok: true, details: 'open-DM enabled on main group' };
    return { ok: true, details: 'open-DM left disabled (operator choice)' };
  },
};
