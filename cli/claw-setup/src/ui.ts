import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import * as clack from '@clack/prompts';
import chalk from 'chalk';
import type { UI } from './types.js';

interface UIOptions {
  noColor: boolean;
}

const SESSION_TIMESTAMP = new Date().toISOString().replace(/[:.]/g, '-');
const LOG_DIR = path.join(os.homedir(), '.config', 'nanoclaw');
const LOG_FILE = path.join(LOG_DIR, `setup-${SESSION_TIMESTAMP}.log`);

let logStream: fs.WriteStream | null = null;

function ensureLogStream(): fs.WriteStream {
  if (!logStream) {
    fs.mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 });
    logStream = fs.createWriteStream(LOG_FILE, { flags: 'a', mode: 0o600 });
  }
  return logStream;
}

function appendLog(line: string): void {
  try {
    const stream = ensureLogStream();
    stream.write(line + '\n');
  } catch {
    // Best-effort logging; don't crash on log failure.
  }
}

export function getLogFilePath(): string {
  return LOG_FILE;
}

export function createUI(options: UIOptions): UI {
  const useColor = !options.noColor;
  const c = (fn: (s: string) => string) => (s: string) => (useColor ? fn(s) : s);
  const green = c(chalk.green);
  const yellow = c(chalk.yellow);
  const red = c(chalk.red);
  const cyan = c(chalk.cyan);
  const dim = c(chalk.dim);
  const bold = c(chalk.bold);

  return {
    intro(title: string, subtitle?: string) {
      appendLog(`[INTRO] ${title}${subtitle ? ' — ' + subtitle : ''}`);
      clack.intro(bold(title));
      if (subtitle) {
        process.stdout.write(dim(subtitle) + '\n');
      }
    },

    step(id: string, title: string) {
      appendLog(`[STEP ${id}] ${title}`);
      process.stdout.write('\n' + cyan(`▸ ${id} `) + bold(title) + '\n');
    },

    success(msg: string) {
      appendLog(`[OK] ${msg}`);
      process.stdout.write(green('  ✓ ') + msg + '\n');
    },

    warn(msg: string) {
      appendLog(`[WARN] ${msg}`);
      process.stdout.write(yellow('  ⚠ ') + msg + '\n');
    },

    error(msg: string) {
      appendLog(`[ERROR] ${msg}`);
      process.stdout.write(red('  ✗ ') + msg + '\n');
    },

    note(label: string, content: string) {
      appendLog(`[NOTE ${label}] ${content}`);
      clack.note(content, label);
    },

    outro(message: string) {
      appendLog(`[OUTRO] ${message}`);
      clack.outro(bold(message));
    },

    async runCommand(
      cmd: string,
      args: string[],
    ): Promise<{ stdout: string; stderr: string; code: number }> {
      appendLog(`[RUN] ${cmd} ${args.join(' ')}`);
      return new Promise((resolve) => {
        const child = spawn(cmd, args, { shell: false });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk: Buffer) => {
          const s = chunk.toString();
          stdout += s;
          appendLog(`[STDOUT] ${s.replace(/\n$/, '')}`);
        });
        child.stderr.on('data', (chunk: Buffer) => {
          const s = chunk.toString();
          stderr += s;
          appendLog(`[STDERR] ${s.replace(/\n$/, '')}`);
        });
        child.on('error', (err) => {
          appendLog(`[ERROR] spawn failed: ${err.message}`);
          resolve({ stdout, stderr: stderr + err.message, code: -1 });
        });
        child.on('close', (code) => {
          appendLog(`[EXIT] ${cmd} → ${code}`);
          resolve({ stdout, stderr, code: code ?? 0 });
        });
      });
    },
  };
}
