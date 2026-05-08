import * as clack from '@clack/prompts';
import type { Step } from '../types.js';

const HEALTH_URL = 'http://localhost:7842/health';
const HEALTH_POLL_INTERVAL_MS = 5_000;
const HEALTH_POLL_TIMEOUT_MS = 60_000;

export const step: Step = {
  id: '10-smoke-test',
  title: 'Smoke test the deployment',

  async check(state) {
    if (state.completedSteps.includes('10-smoke-test')) {
      return { done: true, reason: 'smoke test previously passed' };
    }
    return { done: false };
  },

  async execute(state, ui) {
    if (state.data['__dry_run'] === true) {
      ui.warn('--dry-run set: skipping smoke test.');
      return {};
    }

    // Poll /health for up to 60s. Step 09 just bootstrapped launchd
    // (in the auto-bootstrap path) — the orchestrator needs ~5–15s
    // to bind port 7842 and respond. Polling is the right shape:
    // give it time, but report success the moment it's up.
    ui.note(
      'Verifying orchestrator is up',
      `Polling ${HEALTH_URL} every ${HEALTH_POLL_INTERVAL_MS / 1000}s for up to ${HEALTH_POLL_TIMEOUT_MS / 1000}s.\n` +
        'After launchctl bootstrap, NanoClaw needs ~5–15s to bind the\n' +
        'dashboard port. We wait so the wizard reports an honest result.',
    );

    const startedAt = Date.now();
    let healthOk = false;
    let lastDetail = '';

    while (Date.now() - startedAt < HEALTH_POLL_TIMEOUT_MS) {
      const result = await ui.runCommand('curl', [
        '-sf',
        '-o',
        '/dev/null',
        '-w',
        '%{http_code}',
        HEALTH_URL,
      ]);
      if (result.code === 0) {
        healthOk = true;
        lastDetail = `HTTP ${result.stdout.trim() || '200'}`;
        break;
      }
      lastDetail = `curl exit ${result.code}`;
      const elapsed = Math.round((Date.now() - startedAt) / 1000);
      process.stdout.write(`  · waiting for /health… (${elapsed}s elapsed)\n`);
      await new Promise((resolve) => setTimeout(resolve, HEALTH_POLL_INTERVAL_MS));
    }

    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    if (healthOk) {
      ui.success(`/health responded after ${elapsed}s (${lastDetail}). Orchestrator is up.`);
    } else {
      ui.warn(
        `/health did not respond within ${HEALTH_POLL_TIMEOUT_MS / 1000}s (last: ${lastDetail}).\n` +
          'If you skipped the bootstrap in step 09, that\'s expected. Otherwise:\n' +
          '  launchctl print gui/$(id -u)/com.nanoclaw    # inspect state\n' +
          '  tail -f logs/nanoclaw.log                    # watch startup\n' +
          '  launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.nanoclaw.plist\n' +
          '  launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.nanoclaw.plist',
      );
    }

    if (state.profile === 'hobbyist') {
      ui.note(
        'Local-echo simulation',
        'Hobbyist profile: a synthetic IPC message would round-trip to a synthetic reply here. Implement when wiring the local-echo channel for hobbyist profile.',
      );
      return { data: { smoke_health: healthOk } };
    }

    if (state.profile === 'solo' && healthOk) {
      const mainJid = state.data['main_jid'] as string | undefined;
      const mainName = (state.data['main_name'] as string | undefined) ?? mainJid;
      const target = mainJid
        ? `your registered main group (${mainName})`
        : 'your registered WhatsApp group';
      const ready = await clack.confirm({
        message: `Send a real WhatsApp test message to ${target} now. Press Y when sent.`,
        initialValue: true,
      });
      if (clack.isCancel(ready)) {
        return { data: { smoke_health: healthOk }, warning: 'smoke test skipped by operator' };
      }
      ui.note(
        'Verify reply',
        'The orchestrator should ingest the message + spawn an agent container.\n' +
          'Live progress in another terminal:\n' +
          '  tail -f logs/nanoclaw.log',
      );
    }

    return { data: { smoke_health: healthOk } };
  },

  async verify(state) {
    if (state.data['smoke_health'] === true) {
      return { ok: true, details: '/health responding — orchestrator running' };
    }
    return { ok: true, details: 'smoke test advisory (orchestrator may be starting)' };
  },
};
