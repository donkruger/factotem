#!/usr/bin/env npx tsx
/**
 * X Integration - Follow User
 * Usage: echo '{"username":"karpathy"}' | npx tsx follow.ts
 *
 * Navigates to a user's profile and follows them.
 *
 * Returns structured error codes in data.errorCode:
 *   "user_not_found"     — profile doesn't exist or is suspended
 *   "already_following"  — already following this user
 *   "session_expired"    — login expired
 *   "navigation_error"   — page failed to load
 */

import { getBrowserContext, runScript, config, ScriptResult } from '../lib/browser.js';
import { humanClick, humanWait } from '../lib/human.js';

interface FollowInput {
  username: string;
}

async function followUser(input: FollowInput): Promise<ScriptResult> {
  let { username } = input;

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
      await page.locator('[data-testid="UserName"]').first().waitFor({ timeout: 10000 });
    } catch {
      return {
        success: false,
        message: `Could not load profile for @${username}`,
        data: { errorCode: 'user_not_found' },
      };
    }

    // Check if already following — the button text changes to "Following"
    const unfollowBtn = page.locator('[data-testid$="-unfollow"]').first();
    const alreadyFollowing = await unfollowBtn.isVisible().catch(() => false);
    if (alreadyFollowing) {
      return {
        success: true,
        message: `Already following @${username}`,
        data: { errorCode: 'already_following' },
      };
    }

    // Find and click the Follow button
    const followBtn = page.locator('[data-testid$="-follow"]').first();
    const followVisible = await followBtn.isVisible().catch(() => false);

    if (!followVisible) {
      // Check if this is our own profile
      const editBtn = page.locator('[data-testid="editProfileButton"]').first();
      const isOwnProfile = await editBtn.isVisible().catch(() => false);
      if (isOwnProfile) {
        return { success: false, message: 'Cannot follow yourself', data: { errorCode: 'self_follow' } };
      }

      return {
        success: false,
        message: `Follow button not found for @${username}`,
        data: { errorCode: 'navigation_error' },
      };
    }

    await humanClick(page, followBtn);
    await humanWait(config.timeouts.afterClick * 2);

    // Verify follow succeeded
    const nowFollowing = await unfollowBtn.isVisible().catch(() => false);
    if (nowFollowing) {
      return {
        success: true,
        message: `Now following @${username}`,
      };
    }

    return {
      success: false,
      message: `Follow action completed but could not verify success for @${username}`,
      data: { errorCode: 'verification_failed' },
    };

  } finally {
    if (context) await context.close();
  }
}

runScript<FollowInput>(followUser);
