#!/usr/bin/env npx tsx
/**
 * X Integration - Retweet
 * Usage: echo '{"tweetUrl":"https://x.com/user/status/123"}' | npx tsx retweet.ts
 */

import { getBrowserContext, navigateToTweet, runScript, config, ScriptResult } from '../lib/browser.js';
import { humanClick, humanWait } from '../lib/human.js';

interface RetweetInput {
  tweetUrl: string;
}

async function retweet(input: RetweetInput): Promise<ScriptResult> {
  const { tweetUrl } = input;

  if (!tweetUrl) {
    return { success: false, message: 'Please provide a tweet URL' };
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

    const tweet = page.locator('article[data-testid="tweet"]').first();
    const unretweetButton = tweet.locator('[data-testid="unretweet"]').first();
    const retweetButton = tweet.locator('[data-testid="retweet"]').first();

    // Check if already retweeted
    const alreadyRetweeted = await unretweetButton.isVisible().catch(() => false);
    if (alreadyRetweeted) {
      return { success: true, message: 'Tweet already retweeted' };
    }

    await retweetButton.waitFor({ timeout: config.timeouts.elementWait });
    await humanClick(page, retweetButton);
    await humanWait(config.timeouts.afterClick);

    // Click retweet confirm option
    const retweetConfirm = page.locator('[data-testid="retweetConfirm"]');
    await retweetConfirm.waitFor({ timeout: config.timeouts.elementWait });
    await humanClick(page, retweetConfirm);
    await humanWait(config.timeouts.afterClick * 2);

    // Verify
    const nowRetweeted = await unretweetButton.isVisible().catch(() => false);
    if (nowRetweeted) {
      return { success: true, message: 'Retweet successful' };
    }

    return { success: false, message: 'Retweet action completed but could not verify success', data: { errorCode: 'verification_failed' } };

  } finally {
    if (context) await context.close();
  }
}

runScript<RetweetInput>(retweet);
