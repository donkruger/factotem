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
