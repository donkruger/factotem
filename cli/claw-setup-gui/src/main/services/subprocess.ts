// Subprocess runner with streaming output.
//
// Used by long-running steps (container build, service install) so
// the renderer can show live log output via the LogViewer component.
// Each run gets a unique runId; the renderer subscribes to
// `subprocess:line:<runId>` events while the run is in flight.

import { spawn, type ChildProcess } from 'child_process'
import type { BrowserWindow } from 'electron'
import { randomUUID } from 'crypto'
import { envWithPath } from './path-utils'

interface RunOptions {
  cmd: string
  args?: string[]
  cwd?: string
  env?: Record<string, string>
  shell?: boolean
}

interface RunHandle {
  runId: string
  child: ChildProcess
  promise: Promise<{ code: number; lines: string[] }>
}

const inflight = new Map<string, ChildProcess>()

function getMainWindow(): BrowserWindow | null {
  const { BrowserWindow: BW } = require('electron') as typeof import('electron')
  return BW.getAllWindows()[0] ?? null
}

export function startRun(opts: RunOptions): RunHandle {
  const runId = randomUUID()
  const win = getMainWindow()

  const child = spawn(opts.cmd, opts.args ?? [], {
    cwd: opts.cwd,
    env: { ...envWithPath(), ...(opts.env ?? {}) },
    shell: opts.shell ?? false
  })

  inflight.set(runId, child)

  const lines: string[] = []

  function emit(channel: string, payload: unknown): void {
    if (!win || win.isDestroyed()) return
    win.webContents.send(channel, payload)
  }

  function handleChunk(chunk: Buffer | string): void {
    const text = typeof chunk === 'string' ? chunk : chunk.toString()
    for (const raw of text.split(/\r?\n/)) {
      if (raw.length === 0 && lines.length > 0 && lines[lines.length - 1] === '') continue
      lines.push(raw)
      emit(`subprocess:line:${runId}`, raw)
    }
  }

  child.stdout?.on('data', handleChunk)
  child.stderr?.on('data', handleChunk)

  const promise = new Promise<{ code: number; lines: string[] }>((resolve) => {
    child.on('error', (err) => {
      lines.push(`[spawn error] ${err.message}`)
      emit(`subprocess:line:${runId}`, `[spawn error] ${err.message}`)
      emit(`subprocess:exit:${runId}`, { code: -1 })
      inflight.delete(runId)
      resolve({ code: -1, lines })
    })
    child.on('close', (code) => {
      emit(`subprocess:exit:${runId}`, { code: code ?? -1 })
      inflight.delete(runId)
      resolve({ code: code ?? -1, lines })
    })
  })

  return { runId, child, promise }
}

export function cancelRun(runId: string): boolean {
  const child = inflight.get(runId)
  if (!child) return false
  child.kill('SIGTERM')
  return true
}

// Fire-and-await convenience for short commands that don't need streaming.
export async function runCommand(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: Record<string, string>; shell?: boolean } = {}
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...envWithPath(), ...(opts.env ?? {}) },
      shell: opts.shell ?? false
    })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (d) => (stdout += d.toString()))
    child.stderr?.on('data', (d) => (stderr += d.toString()))
    child.on('error', () => resolve({ stdout, stderr, code: -1 }))
    child.on('close', (code) => resolve({ stdout, stderr, code: code ?? -1 }))
  })
}
