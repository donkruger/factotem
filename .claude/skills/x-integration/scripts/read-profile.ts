#!/usr/bin/env npx tsx
/**
 * X Integration - Read Profile
 * Usage: echo '{"username":"karpathy"}' | npx tsx read-profile.ts
 *
 * Navigates to a user's profile and extracts their bio, metrics, and recent tweets.
 * Enables proactive priority account scanning without waiting for the algorithm.
 *
 * Returns structured error codes in data.errorCode:
 *   "user_not_found"    — profile doesn't exist or is suspended
 *   "session_expired"   — login expired
 *   "navigation_error"  — page failed to load
 */

import { getBrowserContext, runScript, config, ScriptResult } from '../lib/browser.js';
import { humanScroll, humanWait } from '../lib/human.js';

interface ReadProfileInput {
  username: string;
  includeTweets?: boolean;
  tweetCount?: number;
}

interface ProfileData {
  name: string;
  handle: string;
  bio: string;
  location: string;
  website: string;
  joinDate: string;
  followers: string;
  following: string;
  verified: boolean;
  recentTweets: ProfileTweet[];
}

interface ProfileTweet {
  content: string;
  timestamp: string;
  url: string;
  likes: string;
  retweets: string;
  replies: string;
  views: string;
}

async function readProfile(input: ReadProfileInput): Promise<ScriptResult> {
  let { username } = input;
  const includeTweets = input.includeTweets !== false; // default true
  const tweetCount = Math.min(input.tweetCount || 5, 15);

  if (!username?.trim()) {
    return { success: false, message: 'Please provide a username', data: { errorCode: 'missing_input' } };
  }

  // Clean username
  username = username.replace(/^@/, '').replace(/^https?:\/\/(www\.)?(x|twitter)\.com\//, '').split('?')[0];

  let context = null;
  try {
    context = await getBrowserContext();
    const page = context.pages()[0] || await context.newPage();

    await page.goto(`https://x.com/${username}`, {
      timeout: config.timeouts.navigation,
      waitUntil: 'domcontentloaded',
    });
    await humanWait(config.timeouts.pageLoad);

    // Check login
    const isLoggedIn = await page.locator('[data-testid="SideNav_AccountSwitcher_Button"]').isVisible().catch(() => false);
    if (!isLoggedIn) {
      const onLoginPage = await page.locator('input[autocomplete="username"]').isVisible().catch(() => false);
      if (onLoginPage) {
        return { success: false, message: 'X login expired. Run /x-integration to re-authenticate.', data: { errorCode: 'session_expired' } };
      }
    }

    // Check user exists
    const doesntExist = await page.locator('text=/This account doesn.t exist/i').first().isVisible().catch(() => false);
    const isSuspended = await page.locator('text=/Account suspended/i').first().isVisible().catch(() => false);
    if (doesntExist || isSuspended) {
      return {
        success: false,
        message: `User @${username} ${isSuspended ? 'is suspended' : 'does not exist'}`,
        data: { errorCode: 'user_not_found' },
      };
    }

    // Wait for profile to load
    try {
      await page.locator('[data-testid="UserName"]').first().waitFor({ timeout: 15000 });
    } catch {
      return {
        success: false,
        message: `Could not load profile for @${username}`,
        data: { errorCode: 'user_not_found' },
      };
    }

    // Extract profile metadata
    const profile = await page.evaluate(() => {
      const nameEl = document.querySelector('[data-testid="UserName"]');
      const nameText = nameEl?.textContent || '';
      const handleMatch = nameText.match(/@([\w]+)/);
      const handle = handleMatch ? handleMatch[1] : '';
      const atIndex = nameText.indexOf('@');
      const name = atIndex > 0 ? nameText.slice(0, atIndex).trim() : nameText.split('\n')[0]?.trim() || '';

      // Bio
      const bioEl = document.querySelector('[data-testid="UserDescription"]');
      const bio = bioEl?.textContent || '';

      // Location
      const locationEl = document.querySelector('[data-testid="UserLocation"]');
      const location = locationEl?.textContent || '';

      // Website
      const urlEl = document.querySelector('[data-testid="UserUrl"] a');
      const website = urlEl?.textContent || '';

      // Join date
      const joinDateEl = document.querySelector('[data-testid="UserJoinDate"]');
      const joinDate = joinDateEl?.textContent || '';

      // Follower/following counts
      const links = document.querySelectorAll('a[href*="/followers"], a[href*="/following"], a[href*="/verified_followers"]');
      let followers = '';
      let following = '';
      for (const link of links) {
        const href = link.getAttribute('href') || '';
        const text = link.textContent || '';
        if (href.includes('/followers') && !href.includes('/following')) {
          followers = text.replace(/followers?/i, '').trim();
        }
        if (href.includes('/following')) {
          following = text.replace(/following/i, '').trim();
        }
      }

      // Verification
      const verifiedBadge = document.querySelector('[data-testid="UserName"] [data-testid="icon-verified"], [data-testid="UserName"] svg[aria-label*="Verified"]');
      const verified = !!verifiedBadge;

      return { name, handle, bio, location, website, joinDate, followers, following, verified };
    });

    // Extract recent tweets if requested
    const recentTweets: ProfileTweet[] = [];
    if (includeTweets) {
      // Wait for tweets to load
      try {
        await page.locator('article[data-testid="tweet"]').first().waitFor({ timeout: 10000 });
      } catch {
        // Profile may have no tweets (or pinned tweet area is empty)
      }

      const extractTweets = async (): Promise<ProfileTweet[]> => {
        return page.evaluate(() => {
          const articles = document.querySelectorAll('article[data-testid="tweet"]');
          const results: ProfileTweet[] = [];
          for (const article of articles) {
            try {
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
              if (content) results.push({ content, timestamp, url, likes, retweets, replies, views });
            } catch {}
          }
          return results;
        });
      };

      const seen = new Set<string>();
      let scrollAttempts = 0;

      while (recentTweets.length < tweetCount && scrollAttempts < 3) {
        const batch = await extractTweets().catch(() => [] as ProfileTweet[]);
        for (const tweet of batch) {
          if (recentTweets.length >= tweetCount) break;
          const key = tweet.url || tweet.content.slice(0, 50);
          if (seen.has(key)) continue;
          seen.add(key);
          recentTweets.push(tweet);
        }
        if (recentTweets.length < tweetCount) {
          try {
            const lastArticle = page.locator('article[data-testid="tweet"]').last();
            await humanScroll(page, lastArticle);
            await humanWait(config.timeouts.pageLoad);
          } catch { break; }
          scrollAttempts++;
        }
      }
    }

    const profileData: ProfileData = { ...profile, recentTweets };

    // Format summary
    let summary = `@${profileData.handle} (${profileData.name})`;
    if (profileData.verified) summary += ' [verified]';
    summary += `\n${profileData.bio}`;
    if (profileData.location) summary += `\nLocation: ${profileData.location}`;
    if (profileData.website) summary += `\nWebsite: ${profileData.website}`;
    if (profileData.joinDate) summary += `\n${profileData.joinDate}`;
    summary += `\nFollowers: ${profileData.followers} | Following: ${profileData.following}`;

    if (recentTweets.length > 0) {
      summary += `\n\nRecent tweets (${recentTweets.length}):\n`;
      for (const tweet of recentTweets) {
        summary += `\n${tweet.content.slice(0, 120)}${tweet.content.length > 120 ? '...' : ''}`;
        summary += `\n  ${tweet.likes} likes, ${tweet.retweets} RT | ${tweet.url}`;
        if (tweet.timestamp) summary += ` | ${tweet.timestamp}`;
        summary += '\n';
      }
    }

    return {
      success: true,
      message: summary,
      data: profileData,
    };

  } finally {
    if (context) await context.close().catch(() => {});
  }
}

runScript<ReadProfileInput>(readProfile);
