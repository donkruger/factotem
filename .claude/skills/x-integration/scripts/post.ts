#!/usr/bin/env npx tsx
/**
 * X Integration - Post Tweet
 * Usage: echo '{"content":"Hello world"}' | npx tsx post.ts
 */

import { getBrowserContext, runScript, validateContent, config, ScriptResult } from '../lib/browser.js';
import { humanClick, humanType, humanWait } from '../lib/human.js';

interface PostInput {
  content: string;
}

async function postTweet(input: PostInput): Promise<ScriptResult> {
  const { content } = input;

  const validationError = validateContent(content, 'Tweet');
  if (validationError) return validationError;

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

    // Find and fill tweet input
    const tweetInput = page.locator('[data-testid="tweetTextarea_0"]');
    await tweetInput.waitFor({ timeout: config.timeouts.elementWait * 2 });
    await humanType(page, tweetInput, content);
    await humanWait(config.timeouts.afterFill);

    // Click post button
    const postButton = page.locator('[data-testid="tweetButtonInline"]');
    await postButton.waitFor({ timeout: config.timeouts.elementWait });

    const isDisabled = await postButton.getAttribute('aria-disabled');
    if (isDisabled === 'true') {
      return { success: false, message: 'Post button disabled. Content may be empty or exceed character limit.', data: { errorCode: 'submit_disabled' } };
    }

    await humanClick(page, postButton);
    await humanWait(config.timeouts.afterSubmit);

    // Try to capture the posted tweet URL from the page.
    // After posting, X may redirect or show the new tweet in feed.
    // Best-effort: check for a toast/snackbar link or the latest tweet link.
    let postedUrl: string | undefined;
    try {
      // X sometimes shows a "Your post was sent" toast with a "View" link
      const toast = page.locator('[data-testid="toast"] a[href*="/status/"]').first();
      const toastVisible = await toast.isVisible({ timeout: 3000 }).catch(() => false);
      if (toastVisible) {
        const href = await toast.getAttribute('href');
        if (href) postedUrl = `https://x.com${href}`;
      }
    } catch {}

    return {
      success: true,
      message: `Tweet posted: ${content.slice(0, 50)}${content.length > 50 ? '...' : ''}`,
      data: { postedUrl },
    };

  } finally {
    if (context) await context.close();
  }
}

runScript<PostInput>(postTweet);
