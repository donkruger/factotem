#!/usr/bin/env npx tsx
/**
 * X Integration - Like Tweet
 * Usage: echo '{"tweetUrl":"https://x.com/user/status/123"}' | npx tsx like.ts
 */

import { getBrowserContext, navigateToTweet, runScript, config, ScriptResult } from '../lib/browser.js';
import { humanClick, humanWait } from '../lib/human.js';

interface LikeInput {
  tweetUrl: string;
}

async function likeTweet(input: LikeInput): Promise<ScriptResult> {
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
    const unlikeButton = tweet.locator('[data-testid="unlike"]').first();
    const likeButton = tweet.locator('[data-testid="like"]').first();

    // Check if already liked
    const alreadyLiked = await unlikeButton.isVisible().catch(() => false);
    if (alreadyLiked) {
      return { success: true, message: 'Tweet already liked' };
    }

    await likeButton.waitFor({ timeout: config.timeouts.elementWait });
    await humanClick(page, likeButton);
    await humanWait(config.timeouts.afterClick);

    // Verify
    const nowLiked = await unlikeButton.isVisible().catch(() => false);
    if (nowLiked) {
      return { success: true, message: 'Like successful' };
    }

    return { success: false, message: 'Like action completed but could not verify success', data: { errorCode: 'verification_failed' } };

  } finally {
    if (context) await context.close();
  }
}

runScript<LikeInput>(likeTweet);
