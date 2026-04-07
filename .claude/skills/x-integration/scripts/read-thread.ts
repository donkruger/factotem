#!/usr/bin/env npx tsx
/**
 * X Integration - Read Thread
 * Usage: echo '{"tweetUrl":"https://x.com/user/status/123"}' | npx tsx read-thread.ts
 *
 * Navigates to a tweet and extracts the full conversation context:
 * - Parent tweets (what this tweet is replying to)
 * - The focal tweet itself
 * - Replies from other users in the thread
 *
 * Returns structured error codes in data.errorCode:
 *   "tweet_not_found"    — tweet deleted, suspended, or URL invalid
 *   "session_expired"    — login expired
 *   "navigation_error"   — page failed to load
 */

import { getBrowserContext, navigateToTweet, runScript, config, ScriptResult } from '../lib/browser.js';
import { humanScroll, humanWait } from '../lib/human.js';

interface ReadThreadInput {
  tweetUrl: string;
  maxReplies?: number;
}

interface ThreadTweet {
  author: string;
  handle: string;
  content: string;
  timestamp: string;
  url: string;
  likes: string;
  retweets: string;
  replies: string;
  views: string;
  position: 'parent' | 'focal' | 'reply';
}

async function readThread(input: ReadThreadInput): Promise<ScriptResult> {
  const { tweetUrl } = input;
  const maxReplies = Math.min(input.maxReplies || 20, 50);

  if (!tweetUrl) {
    return { success: false, message: 'Please provide a tweet URL', data: { errorCode: 'missing_input' } };
  }

  let context = null;
  try {
    context = await getBrowserContext();
    const { page, success, error } = await navigateToTweet(context, tweetUrl);

    if (!success) {
      const isMissing = error?.includes('not found') || error?.includes('deleted');
      return {
        success: false,
        message: error || 'Navigation failed',
        data: { errorCode: isMissing ? 'tweet_not_found' : 'navigation_error' },
      };
    }

    // Check login
    const isLoggedIn = await page.locator('[data-testid="SideNav_AccountSwitcher_Button"]').isVisible().catch(() => false);
    if (!isLoggedIn) {
      const onLoginPage = await page.locator('input[autocomplete="username"]').isVisible().catch(() => false);
      if (onLoginPage) {
        return { success: false, message: 'X login expired. Run /x-integration to re-authenticate.', data: { errorCode: 'session_expired' } };
      }
    }

    // Extract the focal tweet URL for comparison — normalise to just the path
    const focalPath = tweetUrl.replace(/https?:\/\/(x\.com|twitter\.com)/, '').split('?')[0];

    // Extract all tweets on the page (parent chain + focal + replies)
    const extractAll = async (): Promise<ThreadTweet[]> => {
      return page.evaluate((focalPathArg: string) => {
        const articles = document.querySelectorAll('article[data-testid="tweet"]');
        const results: ThreadTweet[] = [];
        let foundFocal = false;

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

            // Determine position: is this the focal tweet?
            const tweetPath = href.split('?')[0];
            const isFocal = tweetPath === focalPathArg ||
              (focalPathArg.includes('/status/') && tweetPath.includes(focalPathArg.split('/status/')[1]));

            let position: 'parent' | 'focal' | 'reply';
            if (isFocal) {
              position = 'focal';
              foundFocal = true;
            } else if (!foundFocal) {
              position = 'parent';
            } else {
              position = 'reply';
            }

            if (content || author) {
              results.push({ author, handle, content, timestamp, url, likes, retweets, replies, views, position });
            }
          } catch {
            // Skip
          }
        }

        // If we never found a focal tweet, mark the first one as focal
        if (!results.some(t => t.position === 'focal') && results.length > 0) {
          results[0].position = 'focal';
        }

        return results;
      }, focalPath);
    };

    // Initial extraction
    let allTweets = await extractAll();

    // Scroll down to load more replies
    const replyCount = allTweets.filter(t => t.position === 'reply').length;
    let scrollAttempts = 0;
    const maxScrollAttempts = 5;

    while (replyCount < maxReplies && scrollAttempts < maxScrollAttempts) {
      const prevCount = allTweets.length;
      try {
        const lastArticle = page.locator('article[data-testid="tweet"]').last();
        await humanScroll(page, lastArticle);
        await humanWait(config.timeouts.pageLoad);
      } catch {
        break;
      }

      allTweets = await extractAll();
      if (allTweets.length === prevCount) break; // No new tweets loaded
      scrollAttempts++;
    }

    // Deduplicate by URL
    const seen = new Set<string>();
    const unique: ThreadTweet[] = [];
    for (const tweet of allTweets) {
      const key = tweet.url || `${tweet.handle}:${tweet.content.slice(0, 50)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(tweet);
    }

    // Cap replies
    const parents = unique.filter(t => t.position === 'parent');
    const focal = unique.filter(t => t.position === 'focal');
    const replies = unique.filter(t => t.position === 'reply').slice(0, maxReplies);
    const thread = [...parents, ...focal, ...replies];

    // Format human-readable output
    let formatted = `Thread (${parents.length} parent(s), 1 focal, ${replies.length} replies):\n\n`;
    for (const tweet of thread) {
      const label = tweet.position === 'focal' ? '>>> FOCAL TWEET <<<' :
                    tweet.position === 'parent' ? '[PARENT]' : '[REPLY]';
      formatted += `${label}\n`;
      formatted += `${tweet.handle} (${tweet.author})\n`;
      formatted += `${tweet.content}\n`;
      formatted += `  ${tweet.likes} likes, ${tweet.retweets} RT, ${tweet.replies} replies, ${tweet.views} views\n`;
      if (tweet.url) formatted += `  ${tweet.url}\n`;
      if (tweet.timestamp) formatted += `  ${tweet.timestamp}\n`;
      formatted += '---\n';
    }

    return {
      success: true,
      message: formatted,
      data: {
        thread,
        parentCount: parents.length,
        replyCount: replies.length,
        totalCount: thread.length,
      },
    };

  } finally {
    if (context) await context.close();
  }
}

runScript<ReadThreadInput>(readThread);
