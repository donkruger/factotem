/**
 * X Integration - Shared utilities
 * Used by all X scripts
 */

import { chromium, BrowserContext, Page } from 'playwright';
import fs from 'fs';
import path from 'path';
import { config } from './config.js';
import { acquireLock, releaseLock } from './lock.js';

export { config };

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
 * Clean up browser lock files
 */
export function cleanupLockFiles(): void {
  for (const lockFile of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
    const lockPath = path.join(config.browserDataDir, lockFile);
    if (fs.existsSync(lockPath)) {
      try { fs.unlinkSync(lockPath); } catch {}
    }
  }
}

/**
 * Validate tweet/reply content
 */
export function validateContent(content: string | undefined, type = 'Tweet'): ScriptResult | null {
  if (!content || content.length === 0) {
    return { success: false, message: `${type} content cannot be empty` };
  }
  if (content.length > config.limits.tweetMaxLength) {
    return { success: false, message: `${type} exceeds ${config.limits.tweetMaxLength} character limit (current: ${content.length})` };
  }
  return null; // Valid
}

/**
 * Get browser context with persistent profile.
 * Acquires a file-based lock to prevent concurrent access to the Chrome
 * profile — call context.close() when done (the lock releases automatically).
 */
export async function getBrowserContext(): Promise<BrowserContext> {
  if (!fs.existsSync(config.authPath)) {
    throw new Error('X authentication not configured. Run /x-integration to complete login.');
  }

  if (!acquireLock('x-browser')) {
    throw new Error('Another X operation is in progress. Try again shortly.');
  }

  cleanupLockFiles();

  let context: BrowserContext;
  try {
    context = await chromium.launchPersistentContext(config.browserDataDir, {
      executablePath: config.chromePath,
      headless: false,
      viewport: config.viewport,
      args: config.chromeArgs,
      ignoreDefaultArgs: config.chromeIgnoreDefaultArgs,
    });
  } catch (err) {
    releaseLock('x-browser');
    throw err;
  }

  // Clean residual automation markers that X may detect
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    delete (window as any).__playwright;
    delete (window as any).__pw_manual;
  });

  // Release the lock when the context closes (regardless of how)
  context.on('close', () => releaseLock('x-browser'));

  return context;
}

/**
 * Extract tweet ID from URL or raw ID
 */
export function extractTweetId(input: string): string | null {
  const urlMatch = input.match(/(?:x\.com|twitter\.com)\/\w+\/status\/(\d+)/);
  if (urlMatch) return urlMatch[1];
  if (/^\d+$/.test(input.trim())) return input.trim();
  return null;
}

/**
 * Navigate to a tweet page
 */
export async function navigateToTweet(
  context: BrowserContext,
  tweetUrl: string
): Promise<{ page: Page; success: boolean; error?: string }> {
  const page = context.pages()[0] || await context.newPage();

  let url = tweetUrl;
  const tweetId = extractTweetId(tweetUrl);
  if (tweetId && !tweetUrl.startsWith('http')) {
    url = `https://x.com/i/status/${tweetId}`;
  }

  try {
    await page.goto(url, { timeout: config.timeouts.navigation, waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(config.timeouts.pageLoad);

    // Check for explicit "doesn't exist" / suspended / deleted notices
    const tombstone = page.locator('[data-testid="tombstone"], [data-testid="emptyState"]');
    const hasTombstone = await tombstone.isVisible().catch(() => false);
    if (hasTombstone) {
      return { page, success: false, error: 'Tweet not found — deleted or from a suspended account.' };
    }

    const exists = await page.locator('article[data-testid="tweet"]').first().isVisible().catch(() => false);
    if (!exists) {
      return { page, success: false, error: 'Tweet not found. It may have been deleted or the URL is invalid.' };
    }

    return { page, success: true };
  } catch (err) {
    return { page, success: false, error: `Navigation failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * Run script with error handling
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
