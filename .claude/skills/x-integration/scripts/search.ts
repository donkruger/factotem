#!/usr/bin/env npx tsx
/**
 * X Integration - Search Tweets
 * Usage: echo '{"query":"AI agents","count":10,"sort":"latest"}' | npx tsx search.ts
 *
 * Searches X for tweets matching a query. Defaults to "Latest" tab for recency
 * (optimal 2-4h engagement window). Also supports "Top" for algorithmic ranking.
 *
 * Returns structured error codes in data.errorCode:
 *   "no_results"       — search returned no tweets
 *   "session_expired"  — login expired
 *   "navigation_error" — page failed to load
 */

import { getBrowserContext, runScript, config, ScriptResult } from '../lib/browser.js';
import { humanScroll, humanWait } from '../lib/human.js';

interface SearchInput {
  query: string;
  count?: number;
  sort?: 'latest' | 'top';
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
 */
async function extractTweetsFromPage(page: import('playwright').Page): Promise<TweetData[]> {
  return page.evaluate(() => {
    const articles = document.querySelectorAll('article[data-testid="tweet"]');
    const results: TweetData[] = [];

    for (const article of articles) {
      try {
        const userNameEl = article.querySelector('[data-testid="User-Name"]');
        const authorText = userNameEl?.textContent || '';
        const handleMatch = authorText.match(/@([\w]+)/);
        const handle = handleMatch ? `@${handleMatch[1]}` : '';
        const atIndex = authorText.indexOf('@');
        const author = atIndex > 0
          ? authorText.slice(0, atIndex).trim()
          : authorText.split('·')[0]?.trim() || '';

        const tweetTextEl = article.querySelector('[data-testid="tweetText"]');
        const content = tweetTextEl?.textContent || '';

        const timeEl = article.querySelector('time');
        const timestamp = timeEl?.getAttribute('datetime') || '';

        const linkEl = article.querySelector('a[href*="/status/"]');
        const href = linkEl?.getAttribute('href') || '';
        const url = href ? `https://x.com${href}` : '';

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

async function searchTweets(input: SearchInput): Promise<ScriptResult> {
  const { query } = input;
  const count = Math.min(input.count || 10, 25);
  const sort = input.sort || 'latest';

  if (!query?.trim()) {
    return { success: false, message: 'Please provide a search query', data: { errorCode: 'missing_input' } };
  }

  let context = null;
  try {
    context = await getBrowserContext();
    const page = context.pages()[0] || await context.newPage();

    // Build search URL — f=live for Latest, no f param for Top
    const searchParams = new URLSearchParams({
      q: query,
      src: 'typed_query',
    });
    if (sort === 'latest') {
      searchParams.set('f', 'live');
    }
    const searchUrl = `https://x.com/search?${searchParams.toString()}`;

    await page.goto(searchUrl, { timeout: config.timeouts.navigation, waitUntil: 'domcontentloaded' });
    await humanWait(config.timeouts.pageLoad);

    // Check login
    const isLoggedIn = await page.locator('[data-testid="SideNav_AccountSwitcher_Button"]').isVisible().catch(() => false);
    if (!isLoggedIn) {
      const onLoginPage = await page.locator('input[autocomplete="username"]').isVisible().catch(() => false);
      if (onLoginPage) {
        return { success: false, message: 'X login expired. Run /x-integration to re-authenticate.', data: { errorCode: 'session_expired' } };
      }
    }

    // Wait for tweets or empty state
    try {
      await page.locator('article[data-testid="tweet"]').first().waitFor({ timeout: 15000 });
    } catch {
      // Check for "No results" message
      const noResults = await page.locator('text=/No results for/i').first().isVisible().catch(() => false);
      if (noResults) {
        return {
          success: true,
          message: `No results for "${query}"`,
          data: { tweets: [], count: 0 },
        };
      }
      return {
        success: false,
        message: `Search failed — no tweets loaded for "${query}"`,
        data: { errorCode: 'no_results' },
      };
    }

    const tweets: TweetData[] = [];
    const seen = new Set<string>();
    let scrollAttempts = 0;
    const maxScrollAttempts = 5;

    while (tweets.length < count && scrollAttempts < maxScrollAttempts) {
      let batch: TweetData[];
      try {
        batch = await extractTweetsFromPage(page);
      } catch {
        break;
      }

      for (const tweet of batch) {
        if (tweets.length >= count) break;
        const key = `${tweet.handle}:${tweet.content.slice(0, 50)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        tweets.push(tweet);
      }

      if (tweets.length < count) {
        try {
          const lastArticle = page.locator('article[data-testid="tweet"]').last();
          await humanScroll(page, lastArticle);
          await humanWait(config.timeouts.pageLoad);
        } catch {
          break;
        }
        scrollAttempts++;
      }
    }

    if (tweets.length === 0) {
      return {
        success: true,
        message: `No tweets found for "${query}"`,
        data: { tweets: [], count: 0 },
      };
    }

    return {
      success: true,
      message: `Found ${tweets.length} tweet(s) for "${query}" (${sort})`,
      data: { tweets, count: tweets.length, query, sort },
    };

  } finally {
    if (context) await context.close().catch(() => {});
  }
}

runScript<SearchInput>(searchTweets);
