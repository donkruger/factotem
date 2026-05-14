// Open a command in a new terminal window.
//
// Used by CLI-handoff steps (container build, WhatsApp pair, register
// main group, smoke test) so the operator can run the long-form
// command in their real shell while the wizard waits.

import { spawn } from 'child_process'
import os from 'os'

export async function openInTerminal(command: string): Promise<{ success: boolean; error?: string }> {
  try {
    if (process.platform === 'darwin') {
      // osascript tells Terminal.app to open a new tab and run the command.
      // The CLI step modules use the same pattern in the OneCLI install
      // fallback — see cli/claw-setup/src/steps/03-configure-onecli.ts.
      const script = `tell application "Terminal" to do script ${JSON.stringify(command)}`
      spawn('osascript', ['-e', script], { detached: true, stdio: 'ignore' }).unref()
      return { success: true }
    }

    if (process.platform === 'win32') {
      // start cmd /K keeps the window open after the command runs so
      // the user can read the output.
      spawn('cmd', ['/c', 'start', 'cmd', '/K', command], {
        detached: true,
        stdio: 'ignore'
      }).unref()
      return { success: true }
    }

    // Linux: try a few terminal emulators in order of likelihood.
    const candidates = [
      ['gnome-terminal', ['--', 'bash', '-lc', `${command}; exec bash`]],
      ['konsole', ['-e', 'bash', '-lc', `${command}; exec bash`]],
      ['xterm', ['-hold', '-e', 'bash', '-lc', command]]
    ] as Array<[string, string[]]>
    for (const [cmd, args] of candidates) {
      try {
        spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref()
        return { success: true }
      } catch {
        // try next
      }
    }
    return {
      success: false,
      error: 'No supported terminal emulator found (tried gnome-terminal, konsole, xterm).'
    }
  } catch (err) {
    return { success: false, error: (err as Error).message }
  }
}

export function platformLabel(): string {
  if (process.platform === 'darwin') return `macOS ${os.release()}`
  if (process.platform === 'win32') return `Windows ${os.release()}`
  return `Linux ${os.release()}`
}
