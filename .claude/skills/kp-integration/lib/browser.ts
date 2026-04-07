/**
 * KP Integration - Shared utilities
 * Used by all KP scripts
 *
 * Two connection modes:
 * - Mode A: launchKp() — Playwright launches KP via Electron API (clean, reproducible)
 * - Mode B: attachToKp() — Attach to running KP via CDP (live demos)
 */

import { _electron as electron, ElectronApplication, Page } from 'playwright';
import { chromium } from 'playwright';
import { config } from './config.js';
import { DemoCursor } from './cursor.js';

export { config, DemoCursor };

export interface ScriptResult {
  success: boolean;
  message: string;
  data?: unknown;
}

/**
 * Read input from stdin
 */
export async function readInput<T>(): Promise<T> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => {
      try {
        resolve(JSON.parse(data));
      } catch (err) {
        reject(new Error(`Invalid JSON input: ${err}`));
      }
    });
    process.stdin.on('error', reject);
  });
}

/**
 * Write result to stdout
 */
export function writeResult(result: ScriptResult): void {
  console.log(JSON.stringify(result));
}

/**
 * Run script with error handling (same pattern as X integration)
 */
export async function runScript<T>(
  handler: (input: T) => Promise<ScriptResult>
): Promise<void> {
  try {
    const input = await readInput<T>();
    const result = await handler(input);
    writeResult(result);
  } catch (err) {
    writeResult({
      success: false,
      message: `Script execution failed: ${err instanceof Error ? err.message : String(err)}`
    });
    process.exit(0);
  }
}

/**
 * Mode A: Launch KP via Playwright Electron API
 * Best for clean, reproducible demo recordings.
 */
export async function launchKp(): Promise<{ app: ElectronApplication; page: Page; cursor: DemoCursor }> {
  const app = await electron.launch({
    executablePath: config.electronAppPath,
    args: config.electronMainJs ? [config.electronMainJs] : [],
    env: {
      ...process.env,
      NODE_ENV: 'production',
    },
    recordVideo: config.recording.enabled
      ? { dir: config.recording.dir, size: config.recording.size }
      : undefined,
  });

  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');

  // Wait for Angular app to bootstrap
  await page.waitForTimeout(config.timeouts.appLaunch);

  // Initialise demo cursor (injects visual overlay when recording is enabled)
  const cursor = new DemoCursor(page);
  await cursor.init();

  return { app, page, cursor };
}

/**
 * Mode B: Attach to running KP via CDP
 * KP must be launched with: --remote-debugging-port=9222
 * Best for live demos where the user is already using the app.
 *
 * Launch command:
 *   open -a "Kanban Pro" --args --remote-debugging-port=9222
 *
 * IMPORTANT: The Mac App Store build strips debug flags.
 * Use the direct-download .dmg build for this mode.
 */
export async function attachToKp(port = 9222): Promise<Page> {
  const browser = await chromium.connectOverCDP(`http://localhost:${port}`);
  const contexts = browser.contexts();
  if (contexts.length === 0) {
    throw new Error('No browser contexts found. Is KP running with --remote-debugging-port?');
  }
  const pages = contexts[0].pages();
  if (pages.length === 0) {
    throw new Error('No pages found in KP.');
  }
  return pages[0];
}

/**
 * Open a project folder in KP.
 * This is needed after launch — KP starts on the landing page.
 *
 * Strategy: Use Electron's IPC to mock the folder dialog result,
 * since native dialogs can't be controlled by Playwright.
 * This is standard Playwright Electron practice.
 */
export async function openProject(
  app: ElectronApplication,
  page: Page,
  projectPath: string,
  cursor?: DemoCursor,
): Promise<void> {
  // Pre-seed localStorage so KP's restoreLastProjectIfNeeded() auto-opens
  // the project on reload — bypasses the native file dialog entirely.
  await page.evaluate(
    (p) => localStorage.setItem('kanban-last-project-path', p),
    projectPath,
  );

  // page.goto() and page.reload() both fail with ERR_FILE_NOT_FOUND on Electron
  // ASAR file:// URLs — Playwright hands off to raw Chromium which can't read
  // inside app.asar. Triggering the reload from inside the renderer means Electron's
  // own protocol handler intercepts it and ASAR resolution works correctly.
  await page.evaluate(() => location.reload());

  // Wait for at least one column to render — this is the strongest signal that
  // Angular has bootstrapped, restoreLastProjectIfNeeded() has run, and the
  // board is fully initialised. Skipping the landing-screen hidden-state wait
  // avoids a false timeout when KP auto-restores without ever showing the landing.
  await page.waitForSelector('kanban-board kanban-column', {
    timeout: config.timeouts.navigation,
  });
  await page.waitForTimeout(config.timeouts.animationSettle);

  // Re-inject the demo cursor (page reload destroyed the previous one)
  if (cursor) await cursor.init();
}
