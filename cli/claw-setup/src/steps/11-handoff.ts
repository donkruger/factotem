import { randomUUID } from 'crypto';
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

    // Backstop: if machine.json is absent or has no machineId, seed one
    // here so the cheat sheet doesn't show "<not yet generated>". The
    // orchestrator will respect this file on next start; if it has its
    // own version, the existing fields win (we only fill in what's
    // missing). Best-effort — never fails the wizard.
    if (!machine.machineId) {
      try {
        machine = {
          machineId: randomUUID(),
          region: machine.region ?? 'Local',
          hostname: machine.hostname ?? os.hostname(),
        };
        await fs.promises.mkdir(path.dirname(machinePath), { recursive: true, mode: 0o700 });
        await fs.promises.writeFile(machinePath, JSON.stringify(machine, null, 2), {
          mode: 0o600,
        });
      } catch (err) {
        ui.warn(
          `Couldn't seed ${machinePath}: ${(err as Error).message}. ` +
            'Cheat sheet will show placeholders; orchestrator regenerates on first start.',
        );
      }
    }

    const hostname = os.hostname();
    const machineId = machine.machineId ?? '<not yet generated>';
    const region = machine.region ?? '<unknown>';
    const operator = os.userInfo().username;

    // Whether the `claw` operator CLI is installed (~/bin/claw per the /claw
    // skill). When present, the debug cheat-sheet below leads with friendly
    // `claw` verbs (doctor/status/logs); when absent, it falls back to the raw
    // curl/launchctl/tail incantations. Best-effort — same guard style as the
    // doctorInstalled / recoveryInstalled checks above.
    const clawInstalled = fs.existsSync(path.join(os.homedir(), 'bin', 'claw'));

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
        // Bumped timeout to 90s — the curl fallback to the public mirror
        // can take 20-40s on slow connections, plus ditto + xattr + open
        // on top. 30s wasn't enough headroom.
        execSync(`bash "${installer}" 2>&1`, {
          stdio: 'pipe',
          timeout: 90_000,
        });
        doctorInstalled = fs.existsSync(doctorAppPath);
        if (doctorInstalled) {
          ui.success(`Factotem Doctor installed at ${doctorAppPath}`);
        }
      }
    } catch (err) {
      // Surface a short tail of the actual installer output (not just
      // "Command failed"). 5 lines is enough to spot the real error in
      // most cases; the manual install options below are the actionable
      // recovery path. execSync error has stdout/stderr buffers attached
      // when stdio:'pipe'.
      const e = err as Error & { stdout?: Buffer; stderr?: Buffer };
      const output = (
        (e.stdout?.toString() ?? '') + (e.stderr?.toString() ?? '')
      ).trim();
      const tail = output ? output.split('\n').slice(-5).join('\n') : e.message;
      ui.warn(
        'Doctor install failed. Last 5 lines of installer output:\n' +
          tail +
          '\n\nManual install options:\n' +
          '  1. Re-run the installer (uses curl fallback to the public mirror):\n' +
          '       bash scripts/install-doctor.sh\n' +
          '  2. Download the .dmg directly:\n' +
          '       https://github.com/RichardBNel/Factotem/releases/latest/download/Factotem-Doctor.dmg\n' +
          '       Then drag the .app to /Applications.',
      );
    }

    // Cheat-sheet ordering matters for non-technical operators per the
    // 2026-05-08 setup-journey UX audit (assessments/2026-05-08-setup-journey-ux.md
    // F11): the Doctor + dashboard are the daily-use surfaces, the raw
    // Terminal incantations are an emergency-only fallback. Lead with
    // the GUI surfaces, demote the curl/launchctl/tail block to "If you
    // ever need to debug from Terminal" — present but not load-bearing.
    const cheatSheet = [
      '✓ NanoClaw deployment ready',
      '',
      `Operator:     ${operator}`,
      `Machine:      ${machineId} (${region})`,
      '',
      ...(doctorInstalled
        ? [
            'Your daily surface — Factotem Doctor (menu bar):',
            `  ${doctorAppPath} — running in your menu bar now`,
            '  Click the F icon for: Open Dashboard, Repair Stack, Pull updates, Settings, Logs',
            '  The icon refreshes every 5s with Docker / OneCLI / NanoClaw health',
            '',
          ]
        : []),
      `Dashboard (in any browser):  ${dashboardUrl}`,
      '',
      ...(recoveryInstalled
        ? [
            'If something goes wrong — Recovery panel:',
            '  Double-click "Factotem Recovery" on your Desktop',
            `  or open ${recoveryPath}`,
            '',
          ]
        : []),
      'If you ever need to debug from Terminal:',
      ...(clawInstalled
        ? [
            '  claw doctor          (full health check + what to do next)',
            '  claw status          (is NanoClaw up right now?)',
            '  claw logs -f         (live log stream)',
          ]
        : [
            `  curl ${healthUrl} | jq      (health JSON)`,
            '  launchctl list | grep com.nanoclaw     (is the service running?)',
            '  tail -f logs/nanoclaw.log              (live log stream)',
          ]),
    ].join('\n');

    ui.note('Handoff', cheatSheet);
    ui.outro('Setup complete — your assistant is ready.');

    return {};
  },

  async verify(_state) {
    return { ok: true, details: 'handoff displayed' };
  },
};
