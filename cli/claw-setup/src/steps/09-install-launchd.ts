import * as clack from '@clack/prompts';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Step } from '../types.js';

const PLIST_LABEL = 'com.nanoclaw';

function buildPlist(opts: {
  workingDir: string;
  nodePath: string;
  entrypoint: string;
  logDir: string;
}): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${PLIST_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${opts.nodePath}</string>
    <string>${opts.entrypoint}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${opts.workingDir}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>NODE_ENV</key>
    <string>production</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${path.join(opts.logDir, 'nanoclaw.log')}</string>
  <key>StandardErrorPath</key>
  <string>${path.join(opts.logDir, 'nanoclaw.error.log')}</string>
</dict>
</plist>
`;
}

export const step: Step = {
  id: '09-install-launchd',
  title: 'Install launchd plist (macOS)',

  async check(state) {
    if (state.completedSteps.includes('09-install-launchd')) {
      return { done: true, reason: 'plist previously installed' };
    }
    if (process.platform !== 'darwin') {
      return { done: true, reason: 'not macOS — launchd not used' };
    }
    return { done: false };
  },

  async execute(state, ui) {
    if (process.platform !== 'darwin') {
      return {};
    }

    const orchRoot = process.cwd();
    const entrypoint = path.join(orchRoot, 'dist', 'index.js');
    const logDir = path.join(orchRoot, 'logs');
    const nodePath = process.execPath; // current Node binary (R3 friction 5)

    const plist = buildPlist({
      workingDir: orchRoot,
      nodePath,
      entrypoint,
      logDir,
    });

    const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', `${PLIST_LABEL}.plist`);

    if (state.data['__dry_run'] === true) {
      ui.warn(
        `--dry-run set: not writing ${plistPath} or invoking launchctl. Plist content generated successfully (${plist.length} bytes).`,
      );
      return { data: { plist_path: plistPath, plist_dry_run: true } };
    }

    // Write or preserve the plist.
    let plistWritten = false;
    if (fs.existsSync(plistPath)) {
      ui.warn(
        `${plistPath} already exists. Preserving — diff manually if you want the wizard's version.`,
      );
    } else {
      await fs.promises.mkdir(path.dirname(plistPath), { recursive: true });
      await fs.promises.writeFile(plistPath, plist, { mode: 0o644 });
      ui.success(`Wrote ${plistPath}`);
      plistWritten = true;
    }

    // Auto-bootstrap with operator confirmation. Default Yes — the
    // wizard's premise is end-to-end provisioning. Operators who want
    // to delay bootstrap can answer No and run the launchctl command
    // themselves later.
    const uid = process.getuid?.() ?? 501;
    const target = `gui/${uid}`;

    // First check if the service is already loaded.
    const listResult = await ui.runCommand('launchctl', ['print', `${target}/${PLIST_LABEL}`]);
    const alreadyLoaded = listResult.code === 0;
    if (alreadyLoaded) {
      ui.success(`launchd service ${PLIST_LABEL} already loaded — skipping bootstrap.`);
      return { data: { plist_path: plistPath, bootstrapped: true } };
    }

    const bootstrap = await clack.confirm({
      message:
        'Start NanoClaw now? Bootstrapping launches the orchestrator, WhatsApp\n' +
        '  ingestion, and container spawning. You can stop it later with\n' +
        '  `launchctl bootout`.',
      initialValue: true,
    });
    if (clack.isCancel(bootstrap) || !bootstrap) {
      ui.note(
        'Manual bootstrap',
        'Wizard skipped automatic bootstrap. Run when ready:\n' +
          `  launchctl bootstrap ${target} ${plistPath}`,
      );
      return { data: { plist_path: plistPath, bootstrapped: false } };
    }

    const bootstrapResult = await ui.runCommand('launchctl', [
      'bootstrap',
      target,
      plistPath,
    ]);
    if (bootstrapResult.code !== 0) {
      ui.error(
        `launchctl bootstrap failed (exit ${bootstrapResult.code}).\n` +
          'stderr: ' + bootstrapResult.stderr.slice(-400) + '\n' +
          'You can retry with:\n' +
          `  launchctl bootstrap ${target} ${plistPath}`,
      );
      return {
        data: { plist_path: plistPath, bootstrapped: false },
        warning: 'launchctl bootstrap failed',
      };
    }

    ui.success(`Bootstrapped ${PLIST_LABEL}. Orchestrator starting…`);
    return { data: { plist_path: plistPath, bootstrapped: true, plist_written: plistWritten } };
  },

  async verify(state) {
    if (process.platform !== 'darwin') {
      return { ok: true, details: 'not macOS' };
    }
    const plistPath = state.data['plist_path'] as string | undefined;
    if (state.data['plist_dry_run']) {
      return { ok: true, details: 'dry-run: plist generated only' };
    }
    if (state.data['plist_skipped']) {
      return { ok: true, details: 'existing plist preserved' };
    }
    if (plistPath && fs.existsSync(plistPath)) {
      return { ok: true, details: `plist at ${plistPath}` };
    }
    return { ok: false, details: 'plist not present' };
  },
};
