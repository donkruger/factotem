/**
 * X Integration IPC Handler (host-side)
 *
 * Thin wrapper that delegates to the skill's host.ts via subprocess.
 * Handles all x_* IPC messages from container agents.
 */

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { logger } from '../logger.js';

interface SkillResult {
  success: boolean;
  message: string;
  data?: unknown;
}

async function runScript(
  script: string,
  args: object,
  timeoutMs = 120000,
): Promise<SkillResult> {
  const scriptPath = path.join(
    process.cwd(),
    '.claude',
    'skills',
    'x-integration',
    'scripts',
    `${script}.ts`,
  );

  return new Promise((resolve) => {
    // Run tsx via node directly — launchd services have minimal PATH that
    // doesn't include /opt/homebrew/bin, so #!/usr/bin/env node shebangs fail.
    // Bypass by invoking node explicitly with the tsx CLI module.
    const root = process.cwd();
    const nodePath = process.execPath; // the node binary running this process
    const tsxCli = path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');
    const proc = spawn(nodePath, [tsxCli, scriptPath], {
      cwd: root,
      env: { ...process.env, NANOCLAW_ROOT: root },
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
      resolve({
        success: false,
        message: `Script timed out (${timeoutMs / 1000}s)`,
      });
    }, timeoutMs);

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
  const resultsDir = path.join(dataDir, 'ipc', sourceGroup, 'x_results');
  fs.mkdirSync(resultsDir, { recursive: true });
  fs.writeFileSync(
    path.join(resultsDir, `${requestId}.json`),
    JSON.stringify(result),
  );
}

/**
 * Handle X integration IPC messages
 *
 * @returns true if message was handled, false if not an X message
 */
export async function handleXIpc(
  data: Record<string, unknown>,
  sourceGroup: string,
  isMain: boolean,
  dataDir: string,
): Promise<boolean> {
  const type = data.type as string;

  if (!type?.startsWith('x_')) {
    return false;
  }

  if (!isMain) {
    logger.warn({ sourceGroup, type }, 'X integration blocked: not main group');
    return true;
  }

  const requestId = data.requestId as string;
  if (!requestId) {
    logger.warn({ type }, 'X integration blocked: missing requestId');
    return true;
  }

  logger.info({ type, requestId }, 'Processing X request');

  let result: SkillResult;

  switch (type) {
    case 'x_post':
      if (!data.content) {
        result = { success: false, message: 'Missing content' };
        break;
      }
      result = await runScript('post', { content: data.content });
      break;

    case 'x_like':
      if (!data.tweetUrl) {
        result = { success: false, message: 'Missing tweetUrl' };
        break;
      }
      result = await runScript('like', { tweetUrl: data.tweetUrl });
      break;

    case 'x_reply':
      if (!data.tweetUrl || !data.content) {
        result = { success: false, message: 'Missing tweetUrl or content' };
        break;
      }
      result = await runScript('reply', {
        tweetUrl: data.tweetUrl,
        content: data.content,
      });
      break;

    case 'x_retweet':
      if (!data.tweetUrl) {
        result = { success: false, message: 'Missing tweetUrl' };
        break;
      }
      result = await runScript('retweet', { tweetUrl: data.tweetUrl });
      break;

    case 'x_quote':
      if (!data.tweetUrl || !data.comment) {
        result = { success: false, message: 'Missing tweetUrl or comment' };
        break;
      }
      result = await runScript('quote', {
        tweetUrl: data.tweetUrl,
        comment: data.comment,
      });
      break;

    case 'x_read_feed':
      result = await runScript(
        'read-feed',
        {
          count: data.count || 10,
        },
        180000,
      );
      break;

    case 'x_read_notifications':
      result = await runScript(
        'read-notifications',
        {
          count: data.count || 10,
          filter: data.filter || 'all',
        },
        180000,
      );
      break;

    case 'x_dm':
      if (!data.username || !data.message) {
        result = { success: false, message: 'Missing username or message' };
        break;
      }
      result = await runScript('dm', {
        username: data.username,
        message: data.message,
      });
      break;

    case 'x_get_tweet':
      if (!data.tweetUrl) {
        result = { success: false, message: 'Missing tweetUrl' };
        break;
      }
      result = await runScript(
        'get-tweet',
        { tweetUrl: data.tweetUrl },
        180000,
      );
      break;

    case 'x_search':
      if (!data.query) {
        result = { success: false, message: 'Missing query' };
        break;
      }
      result = await runScript(
        'search',
        {
          query: data.query,
          count: data.count || 10,
          sort: data.sort || 'latest',
        },
        180000,
      );
      break;

    case 'x_read_thread':
      if (!data.tweetUrl) {
        result = { success: false, message: 'Missing tweetUrl' };
        break;
      }
      result = await runScript(
        'read-thread',
        { tweetUrl: data.tweetUrl },
        180000,
      );
      break;

    case 'x_read_profile':
      if (!data.username) {
        result = { success: false, message: 'Missing username' };
        break;
      }
      result = await runScript(
        'read-profile',
        {
          username: data.username,
          tweetCount: data.tweetCount || 5,
        },
        180000,
      );
      break;

    case 'x_get_analytics':
      if (!data.tweetUrl) {
        result = { success: false, message: 'Missing tweetUrl' };
        break;
      }
      result = await runScript(
        'get-analytics',
        { tweetUrl: data.tweetUrl },
        180000,
      );
      break;

    case 'x_follow':
      if (!data.username) {
        result = { success: false, message: 'Missing username' };
        break;
      }
      result = await runScript('follow', { username: data.username });
      break;

    default:
      return false;
  }

  writeResult(dataDir, sourceGroup, requestId, result);
  if (result.success) {
    logger.info({ type, requestId }, 'X request completed');
  } else {
    logger.error(
      { type, requestId, message: result.message },
      'X request failed',
    );
  }
  return true;
}
