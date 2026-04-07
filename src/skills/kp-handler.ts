/**
 * KP Integration IPC Handler (host-side)
 *
 * Thin wrapper that delegates to the skill's scripts via subprocess.
 * Handles all kp_* IPC messages from container agents.
 */

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { logger } from '../logger.js';
import { readEnvFile } from '../env.js';

interface SkillResult {
  success: boolean;
  message: string;
  data?: unknown;
}

async function runScript(script: string, args: object): Promise<SkillResult> {
  const scriptPath = path.join(
    process.cwd(),
    '.claude',
    'skills',
    'kp-integration',
    'scripts',
    `${script}.ts`,
  );

  return new Promise((resolve) => {
    // Run tsx via node directly — launchd services have minimal PATH that
    // doesn't include /opt/homebrew/bin, so #!/usr/bin/env node shebangs fail.
    // Bypass by invoking node explicitly with the tsx CLI module.
    const root = process.cwd();
    const nodePath = process.execPath;
    const tsxCli = path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');
    const proc = spawn(nodePath, [tsxCli, scriptPath], {
      cwd: root,
      env: {
        ...process.env,
        ...readEnvFile(['KP_ELECTRON_MAIN', 'KP_PROJECT_PATH', 'KP_APP_PATH']),
        NANOCLAW_ROOT: root,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });
    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });
    proc.stdin.write(JSON.stringify(args));
    proc.stdin.end();

    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      resolve({ success: false, message: 'Script timed out (120s)' });
    }, 120000);

    proc.on('close', (code) => {
      clearTimeout(timer);
      // Always try to parse stdout first — the script writes JSON results
      // even on error, so don't discard them based on exit code alone.
      try {
        const lines = stdout.trim().split('\n');
        const lastLine = lines[lines.length - 1]?.trim();
        if (lastLine) {
          resolve(JSON.parse(lastLine));
          return;
        }
      } catch {}
      // Fallback: stdout wasn't valid JSON
      if (code !== 0) {
        resolve({
          success: false,
          message: `Script exited with code: ${code}${stderr ? ` — ${stderr.slice(0, 500)}` : ''}`,
        });
      } else {
        resolve({
          success: false,
          message: `Failed to parse output: ${stdout.slice(0, 200)}`,
        });
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      resolve({ success: false, message: `Failed to spawn: ${err.message}` });
    });
  });
}

function writeResult(
  dataDir: string,
  sourceGroup: string,
  requestId: string,
  result: SkillResult,
): void {
  const resultsDir = path.join(dataDir, 'ipc', sourceGroup, 'kp_results');
  fs.mkdirSync(resultsDir, { recursive: true });
  fs.writeFileSync(
    path.join(resultsDir, `${requestId}.json`),
    JSON.stringify(result),
  );
}

/**
 * Handle KP integration IPC messages
 *
 * @returns true if message was handled, false if not a kp_* message
 */
export async function handleKpIpc(
  data: Record<string, unknown>,
  sourceGroup: string,
  isMain: boolean,
  dataDir: string,
): Promise<boolean> {
  const type = data.type as string;

  if (!type?.startsWith('kp_')) {
    return false;
  }

  if (!isMain) {
    logger.warn(
      { sourceGroup, type },
      'KP integration blocked: not main group',
    );
    return true;
  }

  const requestId = data.requestId as string;
  if (!requestId) {
    logger.warn({ type }, 'KP integration blocked: missing requestId');
    return true;
  }

  logger.info({ type, requestId }, 'Processing KP request');

  let result: SkillResult;

  switch (type) {
    case 'kp_open_project':
      if (!data.projectPath) {
        result = { success: false, message: 'Missing projectPath' };
        break;
      }
      result = await runScript('open-project', {
        projectPath: data.projectPath,
      });
      break;

    case 'kp_create_ticket':
      if (!data.projectPath || !data.title) {
        result = { success: false, message: 'Missing projectPath or title' };
        break;
      }
      result = await runScript('create-ticket', {
        projectPath: data.projectPath,
        title: data.title,
        columnIndex: data.columnIndex ?? 0,
      });
      break;

    case 'kp_move_ticket':
      if (
        !data.projectPath ||
        !data.ticketTitle ||
        data.targetColumnIndex === undefined
      ) {
        result = {
          success: false,
          message: 'Missing projectPath, ticketTitle, or targetColumnIndex',
        };
        break;
      }
      result = await runScript('move-ticket', {
        projectPath: data.projectPath,
        ticketTitle: data.ticketTitle,
        targetColumnIndex: data.targetColumnIndex,
      });
      break;

    case 'kp_open_ticket':
      if (!data.projectPath || !data.ticketTitle) {
        result = {
          success: false,
          message: 'Missing projectPath or ticketTitle',
        };
        break;
      }
      result = await runScript('open-ticket', {
        projectPath: data.projectPath,
        ticketTitle: data.ticketTitle,
      });
      break;

    case 'kp_update_field':
      if (
        !data.projectPath ||
        !data.ticketTitle ||
        !data.field ||
        !data.value
      ) {
        result = {
          success: false,
          message: 'Missing projectPath, ticketTitle, field, or value',
        };
        break;
      }
      result = await runScript('update-field', {
        projectPath: data.projectPath,
        ticketTitle: data.ticketTitle,
        field: data.field,
        value: data.value,
      });
      break;

    case 'kp_switch_view':
      if (!data.projectPath || !data.view) {
        result = { success: false, message: 'Missing projectPath or view' };
        break;
      }
      result = await runScript('switch-view', {
        projectPath: data.projectPath,
        view: data.view,
      });
      break;

    case 'kp_search':
      if (!data.projectPath || !data.query) {
        result = { success: false, message: 'Missing projectPath or query' };
        break;
      }
      result = await runScript('search', {
        projectPath: data.projectPath,
        query: data.query,
        selectFirst: data.selectFirst ?? false,
      });
      break;

    case 'kp_add_comment':
      if (!data.projectPath || !data.ticketTitle || !data.comment) {
        result = {
          success: false,
          message: 'Missing projectPath, ticketTitle, or comment',
        };
        break;
      }
      result = await runScript('add-comment', {
        projectPath: data.projectPath,
        ticketTitle: data.ticketTitle,
        comment: data.comment,
      });
      break;

    default:
      return false;
  }

  writeResult(dataDir, sourceGroup, requestId, result);
  if (result.success) {
    logger.info({ type, requestId }, 'KP request completed');
  } else {
    logger.error(
      { type, requestId, message: result.message },
      'KP request failed',
    );
  }
  return true;
}
