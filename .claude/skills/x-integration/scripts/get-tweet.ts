#!/usr/bin/env npx tsx
/**
 * X Integration - Get Tweet Metadata
 * Usage: echo '{"tweetUrl":"https://x.com/user/status/123"}' | npx tsx get-tweet.ts
 *
 * Navigates to a tweet and extracts full metadata: content, author info,
 * engagement metrics, reply policy, media type, and thread context.
 *
 * Returns structured error codes in data.errorCode:
 *   "tweet_not_found"    — tweet deleted, suspended, or URL invalid
 *   "session_expired"    — login expired
 *   "navigation_error"   — page failed to load
 */

import { getBrowserContext, navigateToTweet, runScript, config, ScriptResult } from '../lib/browser.js';
import { humanWait } from '../lib/human.js';

interface GetTweetInput {
  tweetUrl: string;
}

interface TweetMetadata {
  author: string;
  handle: string;
  content: string;
  timestamp: string;
  url: string;
  likes: string;
  retweets: string;
  replies: string;
  views: string;
  bookmarks: string;
  authorFollowers: string;
  authorFollowing: string;
  authorVerified: boolean;
  replyPolicy: string;
  hasMedia: boolean;
  mediaType: string;
  isThread: boolean;
  quotedTweet: string | null;
}

async function getTweet(input: GetTweetInput): Promise<ScriptResult> {
  const { tweetUrl } = input;

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

    // Check login state
    const isLoggedIn = await page.locator('[data-testid="SideNav_AccountSwitcher_Button"]').isVisible().catch(() => false);
    if (!isLoggedIn) {
      const onLoginPage = await page.locator('input[autocomplete="username"]').isVisible().catch(() => false);
      if (onLoginPage) {
        return { success: false, message: 'X login expired. Run /x-integration to re-authenticate.', data: { errorCode: 'session_expired' } };
      }
    }

    // Extract full tweet metadata in a single page.evaluate()
    const metadata = await page.evaluate(() => {
      const article = document.querySelector('article[data-testid="tweet"]');
      if (!article) return null;

      // Author info
      const userNameEl = article.querySelector('[data-testid="User-Name"]');
      const authorText = userNameEl?.textContent || '';
      const handleMatch = authorText.match(/@([\w]+)/);
      const handle = handleMatch ? handleMatch[1] : '';
      const atIndex = authorText.indexOf('@');
      const author = atIndex > 0 ? authorText.slice(0, atIndex).trim() : authorText.split('·')[0]?.trim() || '';

      // Verification badge
      const verifiedBadge = article.querySelector('[data-testid="icon-verified"], svg[aria-label="Verified account"]');
      const authorVerified = !!verifiedBadge;

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

      // Engagement metrics — on permalink pages, metrics are displayed as
      // standalone text elements below the tweet, not inside button spans.
      // Try the detail metrics first (larger numbers on permalink page).
      const metricsBar = article.parentElement?.parentElement;

      const likesEl = article.querySelector('[data-testid="like"] span, [data-testid="unlike"] span');
      const likes = likesEl?.textContent || '0';
      const retweetsEl = article.querySelector('[data-testid="retweet"] span, [data-testid="unretweet"] span');
      const retweets = retweetsEl?.textContent || '0';
      const repliesEl = article.querySelector('[data-testid="reply"] span');
      const replies = repliesEl?.textContent || '0';
      const viewsEl = article.querySelector('a[href*="/analytics"] span');
      const views = viewsEl?.textContent || '0';
      const bookmarksEl = article.querySelector('[data-testid="bookmark"] span, [data-testid="removeBookmark"] span');
      const bookmarks = bookmarksEl?.textContent || '0';

      // Media detection
      const hasImage = !!article.querySelector('[data-testid="tweetPhoto"]');
      const hasVideo = !!article.querySelector('[data-testid="videoPlayer"], video, [data-testid="videoComponent"]');
      const hasCard = !!article.querySelector('[data-testid="card.wrapper"]');
      const hasPoll = !!article.querySelector('[data-testid="cardPoll"]');
      const hasMedia = hasImage || hasVideo || hasCard || hasPoll;
      let mediaType = 'none';
      if (hasVideo) mediaType = 'video';
      else if (hasImage) mediaType = 'image';
      else if (hasPoll) mediaType = 'poll';
      else if (hasCard) mediaType = 'card';

      // Quoted tweet
      const quoteTweet = article.querySelector('[data-testid="quoteTweet"]');
      const quotedTweet = quoteTweet ? quoteTweet.textContent?.slice(0, 200) || null : null;

      return {
        author, handle, content, timestamp, url,
        likes, retweets, replies, views, bookmarks,
        authorVerified, hasMedia, mediaType, quotedTweet,
      };
    });

    if (!metadata) {
      return {
        success: false,
        message: 'Failed to extract tweet metadata — tweet article not found after navigation',
        data: { errorCode: 'tweet_not_found' },
      };
    }

    // Check reply policy — look for "Who can reply?" indicator
    const replyPolicy = await page.evaluate(() => {
      // X shows reply restrictions as text below the tweet on permalink pages
      const body = document.body.textContent || '';
      if (body.includes('People @') && body.includes(' mentioned can reply')) return 'mentioned_only';
      if (body.includes('Only people') && body.includes('follows can reply')) return 'followers_only';
      if (body.includes('Only') && body.includes('can reply')) return 'restricted';

      // Check if reply button exists and is not hidden
      const article = document.querySelector('article[data-testid="tweet"]');
      const replyBtn = article?.querySelector('[data-testid="reply"]');
      if (!replyBtn) return 'replies_off';

      return 'everyone';
    });

    // Check for thread (multiple tweets from same author on the page)
    const isThread = await page.evaluate((authorHandle: string) => {
      const articles = document.querySelectorAll('article[data-testid="tweet"]');
      let sameAuthorCount = 0;
      for (const art of articles) {
        const userEl = art.querySelector('[data-testid="User-Name"]');
        const text = userEl?.textContent || '';
        if (text.includes(`@${authorHandle}`)) sameAuthorCount++;
      }
      return sameAuthorCount > 1;
    }, metadata.handle);

    // Try to get author follower/following counts from their profile link hover
    // This is available in the user popover but requires hovering — instead,
    // we'll return empty and let x_read_profile handle deep profile data.
    const fullMetadata: TweetMetadata = {
      ...metadata,
      authorFollowers: '',
      authorFollowing: '',
      replyPolicy,
      isThread,
    };

    // Format a human-readable summary
    let summary = `@${fullMetadata.handle} (${fullMetadata.author})`;
    if (fullMetadata.authorVerified) summary += ' [verified]';
    summary += `\n${fullMetadata.content}`;
    summary += `\n\nEngagement: ${fullMetadata.likes} likes, ${fullMetadata.retweets} retweets, ${fullMetadata.replies} replies, ${fullMetadata.views} views`;
    if (fullMetadata.bookmarks !== '0') summary += `, ${fullMetadata.bookmarks} bookmarks`;
    summary += `\nReply policy: ${fullMetadata.replyPolicy}`;
    if (fullMetadata.hasMedia) summary += `\nMedia: ${fullMetadata.mediaType}`;
    if (fullMetadata.isThread) summary += '\nThis is part of a thread';
    if (fullMetadata.quotedTweet) summary += `\nQuoted: ${fullMetadata.quotedTweet}`;
    if (fullMetadata.timestamp) summary += `\nPosted: ${fullMetadata.timestamp}`;
    summary += `\nURL: ${fullMetadata.url || tweetUrl}`;

    return {
      success: true,
      message: summary,
      data: fullMetadata,
    };

  } finally {
    if (context) await context.close();
  }
}

runScript<GetTweetInput>(getTweet);
