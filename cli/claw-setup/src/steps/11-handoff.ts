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

    // Resolve repo root once — both best-effort installers below live
    // under it. ESM `import.meta.url` resolves the on-disk location of
    // this compiled file; four parents up gets us to the repo root from
    // `cli/claw-setup/dist/steps/11-handoff.js`.
    const { execSync } = await import('child_process');
    const repoRoot = path.resolve(
      path.dirname(new URL(import.meta.url).pathname),
      '..',
      '..',
      '..',
      '..',
    );

    // Phase 0 of the embedded recovery experience: install the static
    // recovery.html + Desktop shortcut so the operator has a discoverable
    // recovery path the next time NanoClaw doesn't come up cleanly. The
    // installer is best-effort and idempotent — never fails the wizard.
    let recoveryInstalled = false;
    let recoveryPath = '';
    try {
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

    // Phase 1 / M1.6 of the embedded recovery experience: install the
    // signed + notarized Tauri Doctor menu-bar app to /Applications so
    // the operator has a persistent, discoverable status icon for
    // Docker / OneCLI / NanoClaw health + a typed-confirm Repair Stack
    // action. Same best-effort pattern as the recovery-panel install:
    // never fails the wizard. If the .app bundle hasn't been built
    // (`cd cli/claw-doctor && cargo tauri build`), the installer exits
    // non-zero with a clear message, which we forward as a `ui.warn`.
    let doctorInstalled = false;
    const doctorAppPath = '/Applications/Factotem Doctor.app';
    try {
      const installer = path.join(repoRoot, 'scripts', 'install-doctor.sh');
      if (fs.existsSync(installer)) {
        execSync(`bash "${installer}"`, {
          stdio: 'pipe',
          timeout: 30_000,
        });
        doctorInstalled = fs.existsSync(doctorAppPath);
      }
    } catch (err) {
      ui.warn(
        `Doctor install skipped: ${(err as Error).message.split('\n')[0]}. ` +
          `Build it with \`cd cli/claw-doctor && cargo tauri build\`, then run ` +
          `\`bash scripts/install-doctor.sh\` to install.`,
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
      ...(doctorInstalled
        ? [
            'Factotem Doctor:',
            `  ${doctorAppPath} — running in your menu bar`,
            '  Click the icon for: Open Dashboard, Repair Stack, Settings, Logs',
            '  Tooltip refreshes every 5s with Docker / OneCLI / NanoClaw health',
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
