#!/usr/bin/env npx tsx
/**
 * X Integration - Read Feed
 * Usage: echo '{"count":10}' | npx tsx read-feed.ts
 *
 * Scrapes the home timeline and returns structured tweet data.
 * Uses batch page.evaluate() extraction to minimise browser round trips.
 */

import { getBrowserContext, runScript, config, ScriptResult } from '../lib/browser.js';
import { humanScroll, humanWait } from '../lib/human.js';

interface ReadFeedInput {
  count?: number;
}

interface TweetData {
  author: string;
  handle: string;
  content: string;
  timestamp: string;
  url: string;
  likes: string;
  retweets: string;
  replies: string;
  views: string;
}

/**
 * Extract all visible tweets in a single page.evaluate() call.
 * One browser round trip instead of ~9 per tweet.
 */
async function extractTweetsFromPage(page: import('playwright').Page): Promise<TweetData[]> {
  return page.evaluate(() => {
    const articles = document.querySelectorAll('article[data-testid="tweet"]');
    const results: TweetData[] = [];

    for (const article of articles) {
      try {
        // Author name + handle from User-Name element
        const userNameEl = article.querySelector('[data-testid="User-Name"]');
        const authorText = userNameEl?.textContent || '';
        const handleMatch = authorText.match(/@([\w]+)/);
        const handle = handleMatch ? `@${handleMatch[1]}` : '';
        const atIndex = authorText.indexOf('@');
        const author = atIndex > 0
          ? authorText.slice(0, atIndex).trim()
          : authorText.split('·')[0]?.trim() || '';

        // Tweet text
        const tweetTextEl = article.querySelector('[data-testid="tweetText"]');
        const content = tweetTextEl?.textContent || '';

        // Timestamp
        const timeEl = article.querySelector('time');
        const timestamp = timeEl?.getAttribute('datetime') || '';

        // Tweet URL
        const linkEl = article.querySelector('a[href*="/status/"]');
        const href = linkEl?.getAttribute('href') || '';
        const url = href ? `https://x.com${href}` : '';

        // Engagement metrics
        const likesEl = article.querySelector('[data-testid="like"] span, [data-testid="unlike"] span');
        const likes = likesEl?.textContent || '0';
        const retweetsEl = article.querySelector('[data-testid="retweet"] span, [data-testid="unretweet"] span');
        const retweets = retweetsEl?.textContent || '0';
        const repliesEl = article.querySelector('[data-testid="reply"] span');
        const replies = repliesEl?.textContent || '0';
        const viewsEl = article.querySelector('a[href*="/analytics"] span');
        const views = viewsEl?.textContent || '0';

        if (content || author) {
          results.push({ author, handle, content, timestamp, url, likes, retweets, replies, views });
        }
      } catch {
        // Skip tweets that fail to parse
      }
    }
    return results;
  });
}

async function readFeed(input: ReadFeedInput): Promise<ScriptResult> {
  const count = Math.min(input.count || 10, 25);

  let context = null;
  try {
    context = await getBrowserContext();
    const page = context.pages()[0] || await context.newPage();

    await page.goto('https://x.com/home', { timeout: config.timeouts.navigation, waitUntil: 'domcontentloaded' });
    await humanWait(config.timeouts.pageLoad);

    // Check if logged in
    const isLoggedIn = await page.locator('[data-testid="SideNav_AccountSwitcher_Button"]').isVisible().catch(() => false);
    if (!isLoggedIn) {
      const onLoginPage = await page.locator('input[autocomplete="username"]').isVisible().catch(() => false);
      if (onLoginPage) {
        return { success: false, message: 'X login expired. Run /x-integration to re-authenticate.', data: { errorCode: 'session_expired' } };
      }
    }

    // Wait for tweets to load — feed is heavier than single-tweet pages,
    // especially on cold Chrome start from launchd service
    await page.locator('article[data-testid="tweet"]').first().waitFor({ timeout: 30000 });

    const tweets: TweetData[] = [];
    const seen = new Set<string>();
    let scrollAttempts = 0;
    const maxScrollAttempts = 5;

    while (tweets.length < count && scrollAttempts < maxScrollAttempts) {
      let batch: TweetData[];
      try {
        batch = await extractTweetsFromPage(page);
      } catch {
        // Browser context died mid-extraction — return what we have
        break;
      }

      for (const tweet of batch) {
        if (tweets.length >= count) break;
        const key = `${tweet.handle}:${tweet.content.slice(0, 50)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        tweets.push(tweet);
      }

      // Scroll down to load more tweets if needed
      if (tweets.length < count) {
        try {
          const lastArticle = page.locator('article[data-testid="tweet"]').last();
          await humanScroll(page, lastArticle);
          await humanWait(config.timeouts.pageLoad);
        } catch {
          // Browser died during scroll — return what we have
          break;
        }
        scrollAttempts++;
      }
    }

    if (tweets.length === 0) {
      return { success: false, message: 'No tweets found on feed. Timeline may be empty or failed to load.', data: { errorCode: 'no_results' } };
    }

    return {
      success: true,
      message: `Retrieved ${tweets.length} tweet(s) from feed`,
      data: { tweets, count: tweets.length },
    };

  } finally {
    if (context) await context.close().catch(() => {});
  }
}

runScript<ReadFeedInput>(readFeed);
