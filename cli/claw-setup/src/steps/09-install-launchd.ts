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

    // For the smoke-test posture: validate generation only, do NOT bootstrap.
    // The actual bootstrap is the operator's call (it's destructive against a
    // possibly-running launchd job). We still write the plist so they can run
    // bootstrap themselves, OR skip writing if they already have a plist.
    if (fs.existsSync(plistPath)) {
      ui.warn(
        `${plistPath} already exists. Skipping write to avoid clobbering an active service. Diff manually if you want the wizard's version.`,
      );
      return { data: { plist_path: plistPath, plist_skipped: true } };
    }

    await fs.promises.mkdir(path.dirname(plistPath), { recursive: true });
    await fs.promises.writeFile(plistPath, plist, { mode: 0o644 });
    ui.success(`Wrote ${plistPath}`);

    ui.note(
      'Bootstrap (manual)',
      `Run when ready:\n  launchctl bootstrap gui/$(id -u) ${plistPath}\nThe wizard does NOT bootstrap automatically — that is operator-controlled.`,
    );

    return { data: { plist_path: plistPath } };
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
