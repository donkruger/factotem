import fs from 'fs';
import type { Step, UI } from '../types.js';

interface PrereqProbe {
  name: string;
  installUrl: string;
  ok: boolean;
  detail: string;
}

/**
 * R3 from the 2026-05-08 setup-journey UX audit
 * (assessments/2026-05-08-setup-journey-ux.md): if Docker Desktop is
 * installed but the daemon isn't running, auto-launch it and wait up
 * to 60s for `docker info` to succeed before classifying as missing.
 *
 * The previous behaviour treated "installed but not started" identically
 * to "not installed at all", which was a high-frequency false-fail —
 * Don's machines hit this every reboot until launchd's Docker autostart
 * kicked in. macOS-only (Docker.app at /Applications/Docker.app); other
 * OSes fall through to the original "missing" classification.
 *
 * Returns the final probe result after the (optional) launch + retry.
 */
async function probeDockerWithAutoLaunch(
  ui: UI,
): Promise<{ ok: boolean; detail: string }> {
  const first = await ui.runCommand('docker', ['info']);
  if (first.code === 0) {
    return { ok: true, detail: 'docker daemon reachable' };
  }

  if (process.platform !== 'darwin') {
    return { ok: false, detail: 'docker info failed' };
  }

  const dockerApp = '/Applications/Docker.app';
  if (!fs.existsSync(dockerApp)) {
    return { ok: false, detail: 'docker not installed (Docker.app missing)' };
  }

  // Installed but not running — try to launch it.
  ui.note(
    'Starting Docker Desktop',
    'Docker is installed but the daemon isn\'t running yet. Launching\n' +
      'Docker Desktop in the background — this typically takes 15–45s on\n' +
      'first boot. We\'ll re-probe every 2s for up to 60s before giving up.',
  );

  const launchResult = await ui.runCommand('open', ['-a', 'Docker']);
  if (launchResult.code !== 0) {
    return {
      ok: false,
      detail: `docker installed but \`open -a Docker\` failed (exit ${launchResult.code}); start Docker Desktop manually and re-run`,
    };
  }

  const startedAt = Date.now();
  const timeoutMs = 60_000;
  const pollIntervalMs = 2_000;
  while (Date.now() - startedAt < timeoutMs) {
    await new Promise((r) => setTimeout(r, pollIntervalMs));
    const probe = await ui.runCommand('docker', ['info']);
    if (probe.code === 0) {
      const elapsedSecs = Math.round((Date.now() - startedAt) / 1000);
      return {
        ok: true,
        detail: `docker daemon came up in ${elapsedSecs}s after auto-launch`,
      };
    }
  }

  return {
    ok: false,
    detail:
      'docker installed but daemon didn\'t come up within 60s; open Docker Desktop manually and re-run',
  };
}

export const step: Step = {
  id: '01-check-prereqs',
  title: 'Check prerequisites (Node, Docker, Tailscale, TCC)',

  async check(state) {
    if (state.completedSteps.includes('01-check-prereqs')) {
      return { done: true, reason: 'previously verified' };
    }
    return { done: false };
  },

  async execute(state, ui) {
    // TCC hard-stop
    const cwd = process.cwd();
    if (process.platform === 'darwin' && /^\/Users\/[^/]+\/Documents\//.test(cwd)) {
      ui.error(
        'Wizard cannot run from `~/Documents/`. macOS TCC silently kills writes. Move NanoClaw to `~/NanoClaw/` or similar.',
      );
      throw new Error('TCC hard-stop: wizard running under ~/Documents/');
    }

    const probes: PrereqProbe[] = [];

    // Node version. Relaxed from ≥24 to ≥20 — verified empirically
    // that Node 22 runs the orchestrator + wizard end-to-end without
    // issue. The orchestrator's package.json `engines` field claims
    // ≥24 but the actual code base doesn't use any 24-specific APIs;
    // 20 LTS is the realistic floor.
    const nodeMajor = parseInt(process.versions.node.split('.')[0] ?? '0', 10);
    probes.push({
      name: 'node',
      installUrl: 'https://nodejs.org/en/download',
      ok: nodeMajor >= 20,
      detail: `node v${process.versions.node}${nodeMajor >= 20 ? ' (≥20 OK)' : ' (need ≥20)'}`,
    });

    // Docker — auto-launch Docker Desktop if installed but not running.
    // See probeDockerWithAutoLaunch for the rationale + 60s wait policy.
    const dockerProbe = await probeDockerWithAutoLaunch(ui);
    probes.push({
      name: 'docker',
      installUrl: 'https://docker.com/products/docker-desktop',
      ok: dockerProbe.ok,
      detail: dockerProbe.detail,
    });

    // Tailscale
    const tsResult = await ui.runCommand('tailscale', ['status']);
    probes.push({
      name: 'tailscale',
      installUrl: 'https://tailscale.com/download',
      ok: tsResult.code === 0,
      detail: tsResult.code === 0 ? 'tailscale up' : 'tailscale not running or not installed',
    });

    for (const p of probes) {
      if (p.ok) {
        ui.success(`${p.name}: ${p.detail}`);
      } else {
        ui.warn(`${p.name} missing or unhealthy — ${p.detail}. Install: ${p.installUrl}`);
      }
    }

    return {
      data: {
        prereqs: probes.map((p) => ({ name: p.name, ok: p.ok, installUrl: p.installUrl })),
      },
    };
  },

  async verify(state) {
    const probes = state.data['prereqs'] as
      | Array<{ name: string; ok: boolean; installUrl: string }>
      | undefined;
    if (!probes) {
      return { ok: false, details: 'no probe data' };
    }
    const missing = probes.filter((p) => !p.ok).map((p) => p.name);
    if (missing.length === 0) {
      return { ok: true, details: 'all prerequisites present' };
    }
    return {
      ok: true, // proceed; step 02 handles install guidance
      details: `missing: ${missing.join(', ')} — step 02 will guide install`,
    };
  },
};
