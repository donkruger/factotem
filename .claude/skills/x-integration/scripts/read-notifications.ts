#!/usr/bin/env npx tsx
/**
 * X Integration - Read Notifications
 * Usage: echo '{"count":10}' | npx tsx read-notifications.ts
 *
 * Scrapes the notifications page and returns structured notification data.
 * Uses batch page.evaluate() extraction to minimise browser round trips.
 */

import { getBrowserContext, runScript, config, ScriptResult } from '../lib/browser.js';
import { humanScroll, humanWait } from '../lib/human.js';

interface ReadNotificationsInput {
  count?: number;
  filter?: 'all' | 'mentions';
}

interface NotificationData {
  type: string;
  actors: string;
  text: string;
  tweetUrl: string;
  timestamp: string;
}

function classifyNotification(text: string): string {
  const lower = text.toLowerCase();
  if (lower.includes('liked your')) return 'like';
  if (lower.includes('retweeted your')) return 'retweet';
  if (lower.includes('replied')) return 'reply';
  if (lower.includes('mentioned you')) return 'mention';
  if (lower.includes('followed you')) return 'follow';
  if (lower.includes('quoted your')) return 'quote';
  if (lower.includes('posted')) return 'post';
  return 'other';
}

interface RawNotification {
  text: string;
  actors: string[];
  tweetUrl: string;
  timestamp: string;
}

/**
 * Extract all visible notifications in a single page.evaluate() call.
 */
async function extractNotificationsFromPage(page: import('playwright').Page): Promise<RawNotification[]> {
  return page.evaluate(() => {
    const cells = document.querySelectorAll('[data-testid="cellInnerDiv"]');
    const results: RawNotification[] = [];

    for (const cell of cells) {
      try {
        const text = cell.textContent || '';
        if (!text.trim() || text.length < 5) continue;

        // Actor links — user profile links within the notification
        const actorLinks = cell.querySelectorAll('a[href^="/"][role="link"]');
        const actors: string[] = [];
        for (let a = 0; a < Math.min(actorLinks.length, 3); a++) {
          const href = actorLinks[a]?.getAttribute('href') || '';
          if (href.match(/^\/\w+$/) && !href.includes('/status/')) {
            actors.push(href.replace('/', '@'));
          }
        }

        // Tweet link
        const tweetLinkEl = cell.querySelector('a[href*="/status/"]');
        const tweetHref = tweetLinkEl?.getAttribute('href') || '';
        const tweetUrl = tweetHref ? `https://x.com${tweetHref}` : '';

        // Timestamp
        const timeEl = cell.querySelector('time');
        const timestamp = timeEl?.getAttribute('datetime') || '';

        results.push({ text: text.slice(0, 200), actors, tweetUrl, timestamp });
      } catch {
        // Skip cells that fail to parse
      }
    }
    return results;
  });
}

async function readNotifications(input: ReadNotificationsInput): Promise<ScriptResult> {
  const count = Math.min(input.count || 10, 25);
  const filter = input.filter || 'all';

  let context = null;
  try {
    context = await getBrowserContext();
    const page = context.pages()[0] || await context.newPage();

    // Navigate to notifications (mentions tab if requested)
    const notifUrl = filter === 'mentions'
      ? 'https://x.com/notifications/mentions'
      : 'https://x.com/notifications';

    await page.goto(notifUrl, { timeout: config.timeouts.navigation, waitUntil: 'domcontentloaded' });
    await humanWait(config.timeouts.pageLoad);

    // Check if logged in
    const isLoggedIn = await page.locator('[data-testid="SideNav_AccountSwitcher_Button"]').isVisible().catch(() => false);
    if (!isLoggedIn) {
      const onLoginPage = await page.locator('input[autocomplete="username"]').isVisible().catch(() => false);
      if (onLoginPage) {
        return { success: false, message: 'X login expired. Run /x-integration to re-authenticate.', data: { errorCode: 'session_expired' } };
      }
    }

    // Wait for notification items to load
    const cellSelector = '[data-testid="cellInnerDiv"]';
    try {
      await page.locator(cellSelector).first().waitFor({ timeout: 30000 });
    } catch {
      return { success: false, message: 'No notifications found or page failed to load.', data: { errorCode: 'no_results' } };
    }

    const notifications: NotificationData[] = [];
    const seen = new Set<string>();
    let scrollAttempts = 0;
    const maxScrollAttempts = 5;

    while (notifications.length < count && scrollAttempts < maxScrollAttempts) {
      let batch: RawNotification[];
      try {
        batch = await extractNotificationsFromPage(page);
      } catch {
        // Browser context died mid-extraction — return what we have
        break;
      }

      for (const raw of batch) {
        if (notifications.length >= count) break;
        if (seen.has(raw.text)) continue;
        seen.add(raw.text);

        notifications.push({
          type: classifyNotification(raw.text),
          actors: raw.actors.join(', ') || 'unknown',
          text: raw.text,
          tweetUrl: raw.tweetUrl,
          timestamp: raw.timestamp,
        });
      }

      // Scroll to load more
      if (notifications.length < count) {
        try {
          const lastCell = page.locator(cellSelector).last();
          await humanScroll(page, lastCell);
          await humanWait(config.timeouts.pageLoad);
        } catch {
          // Browser died during scroll — return what we have
          break;
        }
        scrollAttempts++;
      }
    }

    if (notifications.length === 0) {
      return { success: false, message: 'No notifications found. Notifications may be empty or failed to load.', data: { errorCode: 'no_results' } };
    }

    return {
      success: true,
      message: `Retrieved ${notifications.length} notification(s)`,
      data: { notifications, count: notifications.length },
    };

  } finally {
    if (context) await context.close().catch(() => {});
  }
}

runScript<ReadNotificationsInput>(readNotifications);
