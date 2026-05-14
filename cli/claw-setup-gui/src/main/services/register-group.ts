// Main WhatsApp group registration.
//
// The orchestrator exposes everything we need as non-interactive
// subcommands of `setup/index.ts`:
//
//   `npx tsx setup/index.ts --step groups -- --list`
//      Prints `<jid>|<name>` lines for every group the orchestrator has
//      observed since startup. No interactive UI. We parse the stdout.
//
//   `npx tsx setup/index.ts --step register -- --jid ... --name ... \
//        --trigger '@Andy' --folder my-group --is-main --assistant-name Andy`
//      Writes the registered_groups row + creates the group folder +
//      sets up CLAUDE.md. All values as flags, no prompts.
//
// After registration the orchestrator needs SIGHUP to hot-reload its
// registered-groups list. We get the pid from /health and signal it.

import { runCommand } from './subprocess'
import { probeHealth } from './health-probe'

export interface WhatsAppGroup {
  jid: string
  name: string
}

export async function listGroups(orchestratorRoot: string): Promise<{
  groups: WhatsAppGroup[]
  error?: string
}> {
  const r = await runCommand(
    'npx',
    ['tsx', 'setup/index.ts', '--step', 'groups', '--', '--list'],
    { cwd: orchestratorRoot }
  )
  if (r.code !== 0) {
    return {
      groups: [],
      error:
        r.stderr.trim().split('\n').slice(-2).join(' · ') ||
        `groups --list exited ${r.code}`
    }
  }
  const groups: WhatsAppGroup[] = r.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.includes('|'))
    .map((line) => {
      const [jid, ...rest] = line.split('|')
      return { jid: jid.trim(), name: rest.join('|').trim() }
    })
    .filter((g) => g.jid && g.name)
  return { groups }
}

export interface RegisterInput {
  jid: string
  name: string
  trigger: string
  folder: string
  isMain: boolean
  assistantName: string
}

export async function registerGroup(
  orchestratorRoot: string,
  input: RegisterInput
): Promise<{ success: boolean; sighup: boolean; error?: string }> {
  const args = [
    'tsx',
    'setup/index.ts',
    '--step',
    'register',
    '--',
    '--jid',
    input.jid,
    '--name',
    input.name,
    '--trigger',
    input.trigger,
    '--folder',
    input.folder,
    '--assistant-name',
    input.assistantName,
    '--channel',
    'whatsapp'
  ]
  if (input.isMain) args.push('--is-main')

  const r = await runCommand('npx', args, { cwd: orchestratorRoot })
  if (r.code !== 0) {
    return {
      success: false,
      sighup: false,
      error:
        r.stderr.trim().split('\n').slice(-3).join(' · ') ||
        `register exited ${r.code}`
    }
  }

  // Hot-reload the orchestrator. Same step the CLI's 07 does — SIGHUP
  // tells the running orchestrator to re-read registered_groups. Best-
  // effort: if /health doesn't expose a pid or the kill fails, the user
  // just needs to restart the service to pick up the new row.
  const health = await probeHealth(2000)
  if (health.reachable && health.nanoclaw.pid) {
    try {
      process.kill(health.nanoclaw.pid, 'SIGHUP')
      return { success: true, sighup: true }
    } catch {
      return { success: true, sighup: false }
    }
  }
  return { success: true, sighup: false }
}
