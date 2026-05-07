import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Step } from '../types.js';

interface MachineJson {
  machineId?: string;
  region?: string;
  hostname?: string;
}

export const step: Step = {
  id: '11-handoff',
  title: 'Handoff and operator cheat-sheet',

  async check(state) {
    if (state.completedSteps.includes('11-handoff')) {
      return { done: true, reason: 'handoff already shown' };
    }
    return { done: false };
  },

  async execute(_state, ui) {
    let machine: MachineJson = {};
    const machinePath = path.join(os.homedir(), '.config', 'nanoclaw', 'machine.json');
    try {
      if (fs.existsSync(machinePath)) {
        machine = JSON.parse(await fs.promises.readFile(machinePath, 'utf8')) as MachineJson;
      }
    } catch {
      // best-effort
    }

    const hostname = os.hostname();
    const machineId = machine.machineId ?? '<not yet generated>';
    const region = machine.region ?? '<unknown>';
    const operator = os.userInfo().username;

    const dashboardUrl = `http://${hostname}:7842`;
    const healthUrl = `http://${hostname}:7842/health`;

    // Phase 0 of the embedded recovery experience: install the static
    // recovery.html + Desktop shortcut so the operator has a discoverable
    // recovery path the next time NanoClaw doesn't come up cleanly. The
    // installer is best-effort and idempotent — never fails the wizard.
    let recoveryInstalled = false;
    let recoveryPath = '';
    try {
      const { execSync } = await import('child_process');
      // Resolve the script path relative to this wizard package's repo
      // root. The install is macOS-only; the script no-ops on other OSes.
      const repoRoot = path.resolve(
        path.dirname(new URL(import.meta.url).pathname),
        '..',
        '..',
        '..',
        '..',
      );
      const installer = path.join(repoRoot, 'scripts', 'install-recovery.sh');
      if (fs.existsSync(installer)) {
        execSync(`bash "${installer}"`, {
          stdio: 'pipe',
          timeout: 10_000,
        });
        recoveryInstalled = true;
        recoveryPath = path.join(
          os.homedir(),
          'Library',
          'Application Support',
          'Factotem',
          'recovery.html',
        );
      }
    } catch (err) {
      ui.warn(
        `Recovery panel install skipped: ${(err as Error).message}. ` +
          `Run \`bash scripts/install-recovery.sh\` manually if you'd like the Desktop shortcut.`,
      );
    }

    const cheatSheet = [
      '✓ NanoClaw deployment ready',
      '',
      `Dashboard:    ${dashboardUrl}`,
      `Health:       ${healthUrl}`,
      `Operator:     ${operator}`,
      `Machine:      ${machineId} (${region})`,
      '',
      'Common commands:',
      '  curl http://localhost:7842/health | jq',
      '  launchctl list | grep com.nanoclaw',
      '  tail -f logs/nanoclaw.log',
      '',
      ...(recoveryInstalled
        ? [
            'Recovery panel:',
            '  Double-click "Factotem Recovery" on your Desktop',
            `  or open ${recoveryPath}`,
            '',
          ]
        : []),
      'Brain ticket integration: kanbanpro://open-ticket?id=...',
    ].join('\n');

    ui.note('Handoff', cheatSheet);
    ui.outro('Setup complete — happy clawing.');

    return {};
  },

  async verify(_state) {
    return { ok: true, details: 'handoff displayed' };
  },
};
