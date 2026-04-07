#!/usr/bin/env npx tsx
/**
 * X Integration - Get Tweet Analytics
 * Usage: echo '{"tweetUrl":"https://x.com/user/status/123"}' | npx tsx get-analytics.ts
 *
 * Navigates to a tweet's analytics page and extracts performance data.
 * Only works for tweets posted by the authenticated account.
 *
 * Returns structured error codes in data.errorCode:
 *   "tweet_not_found"    — tweet deleted or URL invalid
 *   "not_own_tweet"      — analytics only available for own tweets
 *   "session_expired"    — login expired
 *   "navigation_error"   — page failed to load
 */

import { getBrowserContext, extractTweetId, runScript, config, ScriptResult } from '../lib/browser.js';
import { humanWait } from '../lib/human.js';

interface GetAnalyticsInput {
  tweetUrl: string;
}

interface AnalyticsData {
  impressions: string;
  engagements: string;
  detailExpands: string;
  newFollowers: string;
  profileVisits: string;
  likes: string;
  retweets: string;
  replies: string;
  bookmarks: string;
  shares: string;
  linkClicks: string;
  mediaViews: string;
  mediaEngagements: string;
}

async function getAnalytics(input: GetAnalyticsInput): Promise<ScriptResult> {
  const { tweetUrl } = input;

  if (!tweetUrl) {
    return { success: false, message: 'Please provide a tweet URL', data: { errorCode: 'missing_input' } };
  }

  const tweetId = extractTweetId(tweetUrl);
  if (!tweetId) {
    return { success: false, message: 'Invalid tweet URL — could not extract tweet ID', data: { errorCode: 'tweet_not_found' } };
  }

  let context = null;
  try {
    context = await getBrowserContext();
    const page = context.pages()[0] || await context.newPage();

    // Navigate to the analytics page directly
    const analyticsUrl = `https://x.com/i/status/${tweetId}/analytics`;
    await page.goto(analyticsUrl, {
      timeout: config.timeouts.navigation,
      waitUntil: 'domcontentloaded',
    });
    await humanWait(config.timeouts.pageLoad * 1.5);

    // Check login
    const isLoggedIn = await page.locator('[data-testid="SideNav_AccountSwitcher_Button"]').isVisible().catch(() => false);
    if (!isLoggedIn) {
      const onLoginPage = await page.locator('input[autocomplete="username"]').isVisible().catch(() => false);
      if (onLoginPage) {
        return { success: false, message: 'X login expired. Run /x-integration to re-authenticate.', data: { errorCode: 'session_expired' } };
      }
    }

    // Check for error states
    const tombstone = await page.locator('[data-testid="tombstone"], [data-testid="emptyState"]').first().isVisible().catch(() => false);
    if (tombstone) {
      return {
        success: false,
        message: 'Tweet not found — deleted or from a suspended account',
        data: { errorCode: 'tweet_not_found' },
      };
    }

    // Check if we got "You can only see analytics for your own posts"
    const notOwn = await page.locator('text=/only see analytics/i, text=/your own/i').first().isVisible().catch(() => false);
    if (notOwn) {
      return {
        success: false,
        message: 'Analytics are only available for your own tweets',
        data: { errorCode: 'not_own_tweet' },
      };
    }

    // Wait for analytics content to load
    await humanWait(config.timeouts.pageLoad);

    // Extract analytics data from the page
    const analytics = await page.evaluate(() => {
      const body = document.body;

      // Helper to find a metric value by its label text
      function findMetric(label: string): string {
        const elements = body.querySelectorAll('span, div, h2, h3');
        for (const el of elements) {
          const text = el.textContent?.trim() || '';
          if (text.toLowerCase().includes(label.toLowerCase())) {
            // The value is usually in a sibling or parent element
            const parent = el.parentElement;
            if (parent) {
              const spans = parent.querySelectorAll('span');
              for (const span of spans) {
                const val = span.textContent?.trim() || '';
                // Metric values are typically numbers (possibly with K, M suffixes)
                if (val !== text && /^[\d,.]+[KMBkmb]?$/.test(val)) {
                  return val;
                }
              }
            }
            // Check previous sibling
            const prev = el.previousElementSibling;
            if (prev) {
              const val = prev.textContent?.trim() || '';
              if (/^[\d,.]+[KMBkmb]?$/.test(val)) return val;
            }
          }
        }
        return '0';
      }

      // Try a more structured approach — X analytics uses data-testid or specific layout
      // Look for all metric-like elements (large numbers near label text)
      const allText = body.textContent || '';

      return {
        impressions: findMetric('impression'),
        engagements: findMetric('engagement'),
        detailExpands: findMetric('detail expand'),
        newFollowers: findMetric('new follower'),
        profileVisits: findMetric('profile visit'),
        likes: findMetric('like'),
        retweets: findMetric('retweet'),
        replies: findMetric('repl'),
        bookmarks: findMetric('bookmark'),
        shares: findMetric('share'),
        linkClicks: findMetric('link click'),
        mediaViews: findMetric('media view'),
        mediaEngagements: findMetric('media engagement'),
        rawText: allText.slice(0, 1000), // Fallback for debugging
      };
    });

    const { rawText, ...cleanAnalytics } = analytics;

    // Format summary
    let summary = `Analytics for tweet ${tweetId}:\n`;
    summary += `Impressions: ${cleanAnalytics.impressions}\n`;
    summary += `Engagements: ${cleanAnalytics.engagements}\n`;
    if (cleanAnalytics.likes !== '0') summary += `Likes: ${cleanAnalytics.likes}\n`;
    if (cleanAnalytics.retweets !== '0') summary += `Retweets: ${cleanAnalytics.retweets}\n`;
    if (cleanAnalytics.replies !== '0') summary += `Replies: ${cleanAnalytics.replies}\n`;
    if (cleanAnalytics.bookmarks !== '0') summary += `Bookmarks: ${cleanAnalytics.bookmarks}\n`;
    if (cleanAnalytics.shares !== '0') summary += `Shares: ${cleanAnalytics.shares}\n`;
    if (cleanAnalytics.detailExpands !== '0') summary += `Detail Expands: ${cleanAnalytics.detailExpands}\n`;
    if (cleanAnalytics.newFollowers !== '0') summary += `New Followers: ${cleanAnalytics.newFollowers}\n`;
    if (cleanAnalytics.profileVisits !== '0') summary += `Profile Visits: ${cleanAnalytics.profileVisits}\n`;
    if (cleanAnalytics.linkClicks !== '0') summary += `Link Clicks: ${cleanAnalytics.linkClicks}\n`;
    if (cleanAnalytics.mediaViews !== '0') summary += `Media Views: ${cleanAnalytics.mediaViews}\n`;

    return {
      success: true,
      message: summary,
      data: cleanAnalytics,
    };

  } finally {
    if (context) await context.close();
  }
}

runScript<GetAnalyticsInput>(getAnalytics);
