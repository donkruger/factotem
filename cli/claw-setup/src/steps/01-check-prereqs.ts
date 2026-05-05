import type { Step } from '../types.js';

interface PrereqProbe {
  name: string;
  installUrl: string;
  ok: boolean;
  detail: string;
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

    // Node version
    const nodeMajor = parseInt(process.versions.node.split('.')[0] ?? '0', 10);
    probes.push({
      name: 'node',
      installUrl: 'https://nodejs.org/en/download',
      ok: nodeMajor >= 24,
      detail: `node v${process.versions.node}${nodeMajor >= 24 ? ' (≥24 OK)' : ' (need ≥24)'}`,
    });

    // Docker
    const dockerResult = await ui.runCommand('docker', ['info']);
    probes.push({
      name: 'docker',
      installUrl: 'https://docker.com/products/docker-desktop',
      ok: dockerResult.code === 0,
      detail: dockerResult.code === 0 ? 'docker daemon reachable' : 'docker info failed',
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
