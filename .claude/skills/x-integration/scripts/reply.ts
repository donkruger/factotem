#!/usr/bin/env npx tsx
/**
 * X Integration - Reply to Tweet
 * Usage: echo '{"tweetUrl":"https://x.com/user/status/123","content":"Great post!"}' | npx tsx reply.ts
 *
 * Two reply strategies:
 *   1. Dialog method — click reply button → type in modal dialog (default)
 *   2. Inline method — use the reply composer below the tweet on its permalink page
 *      (fallback when dialog fails, e.g. embedded video tweets intercepting clicks)
 *
 * Returns structured failure categories in data.failureCategory:
 *   "strict_mode"        — multiple reply buttons found (sticky header / thread)
 *   "timeout"            — both dialog and inline methods failed
 *   "replies_restricted"  — tweet has restricted replies (Premium-only / mentions-only)
 *   "tweet_not_found"    — tweet deleted or URL invalid
 *   "submit_disabled"    — content issue (empty / too long)
 */

import { getBrowserContext, navigateToTweet, runScript, validateContent, config, ScriptResult } from '../lib/browser.js';
import { humanClick, humanType, humanWait } from '../lib/human.js';
import { Page } from 'playwright';

interface ReplyInput {
  tweetUrl: string;
  content: string;
}

/**
 * Strategy 1: Click reply button → type in modal dialog.
 * Returns null on success (result already written), or a failureCategory string to try fallback.
 */
async function tryDialogReply(
  page: Page,
  content: string,
): Promise<ScriptResult | 'try_inline'> {
  const tweet = page.locator('article[data-testid="tweet"]').first();
  const replyButton = tweet.locator('[data-testid="reply"]').first();

  const replyVisible = await replyButton.isVisible().catch(() => false);
  if (!replyVisible) {
    return {
      success: false,
      message: 'Reply button not visible — replies may be restricted on this tweet',
      data: { failureCategory: 'replies_restricted' },
    };
  }

  // Click reply button
  try {
    await humanClick(page, replyButton);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('strict mode') || msg.includes('resolved to')) {
      // Multiple reply buttons — skip dialog, try inline
      return 'try_inline';
    }
    throw err;
  }
  await humanWait(config.timeouts.afterClick * 1.5);

  // Check for "Who can reply?" restriction modal.
  // X shows this instead of the reply composer when replies are limited.
  // It appears as a dialog/sheet with text like "Only some accounts can reply."
  const restrictionModal = page.locator('text=/Only some accounts can reply/i').first();
  const hasRestrictionModal = await restrictionModal.isVisible().catch(() => false);
  if (hasRestrictionModal) {
    return {
      success: false,
      message: 'Replies restricted — "Only some accounts can reply." This account is not permitted to reply to this tweet.',
      data: { failureCategory: 'replies_restricted' },
    };
  }

  // Wait for reply dialog
  const dialog = page.locator('[role="dialog"][aria-modal="true"]');
  try {
    await dialog.waitFor({ timeout: config.timeouts.elementWait });
  } catch {
    // Check for restriction notices (alternative selectors)
    const restrictionNotice = page.locator('[data-testid="inline_reply_offboarding"]');
    const hasRestriction = await restrictionNotice.isVisible().catch(() => false);
    if (hasRestriction) {
      return {
        success: false,
        message: 'Replies restricted on this tweet (Premium-only or mentions-only)',
        data: { failureCategory: 'replies_restricted' },
      };
    }

    // One more check — the "Who can reply?" text may appear after a delay
    const lateRestriction = await page.locator('text=/Only some accounts can reply/i').first().isVisible().catch(() => false);
    if (lateRestriction) {
      return {
        success: false,
        message: 'Replies restricted — "Only some accounts can reply." This account is not permitted to reply to this tweet.',
        data: { failureCategory: 'replies_restricted' },
      };
    }

    // Dialog didn't open — fall back to inline
    return 'try_inline';
  }

  // The dialog opened — but verify it's actually a reply composer,
  // not the "Who can reply?" info modal (which also uses role="dialog").
  const dialogText = await dialog.textContent().catch(() => '') || '';
  if (dialogText.includes('Only some accounts can reply') || dialogText.includes('Who can reply')) {
    return {
      success: false,
      message: 'Replies restricted — "Only some accounts can reply." This account is not permitted to reply to this tweet.',
      data: { failureCategory: 'replies_restricted' },
    };
  }

  // Fill reply in dialog
  const replyInput = dialog.locator('[data-testid="tweetTextarea_0"]');
  try {
    await replyInput.waitFor({ timeout: config.timeouts.elementWait });
  } catch {
    // Dialog opened but no textarea — likely a restriction or info modal
    return {
      success: false,
      message: 'Reply dialog opened but no text input found — replies may be restricted',
      data: { failureCategory: 'replies_restricted' },
    };
  }
  await humanType(page, replyInput, content);
  await humanWait(config.timeouts.afterFill);

  const submitButton = dialog.locator('[data-testid="tweetButton"]');
  await submitButton.waitFor({ timeout: config.timeouts.elementWait });

  const isDisabled = await submitButton.getAttribute('aria-disabled');
  if (isDisabled === 'true') {
    return {
      success: false,
      message: 'Submit button disabled. Content may be empty or exceed character limit.',
      data: { failureCategory: 'submit_disabled' },
    };
  }

  await humanClick(page, submitButton);
  await humanWait(config.timeouts.afterSubmit);

  // Try to capture posted reply URL from toast notification
  let postedUrl: string | undefined;
  try {
    const toast = page.locator('[data-testid="toast"] a[href*="/status/"]').first();
    const toastVisible = await toast.isVisible({ timeout: 3000 }).catch(() => false);
    if (toastVisible) {
      const href = await toast.getAttribute('href');
      if (href) postedUrl = `https://x.com${href}`;
    }
  } catch {}

  return {
    success: true,
    message: `Reply posted (dialog): ${content.slice(0, 50)}${content.length > 50 ? '...' : ''}`,
    data: { postedUrl },
  };
}

/**
 * Strategy 2: Use the inline reply composer on the tweet permalink page.
 * On individual tweet pages, X renders a reply box below the main tweet
 * (outside any dialog). This bypasses the dialog entirely — useful when
 * embedded media (video/audio) intercepts the reply-button click.
 */
async function tryInlineReply(
  page: Page,
  content: string,
): Promise<ScriptResult> {
  // Dismiss any half-opened dialog or overlay that may be blocking
  await page.keyboard.press('Escape');
  await humanWait(500);

  // On a tweet permalink page the inline reply composer sits below the
  // primary tweet.  Its textarea shares the same data-testid as the
  // compose box, but it lives outside any dialog element.
  // We target textareas that are NOT inside a [role="dialog"].
  const inlineTextarea = page.locator(
    '[data-testid="tweetTextarea_0"]:not([role="dialog"] [data-testid="tweetTextarea_0"])',
  ).first();

  const inlineVisible = await inlineTextarea.isVisible({ timeout: config.timeouts.elementWait }).catch(() => false);

  if (!inlineVisible) {
    // Try scrolling down — the inline composer may be below the fold,
    // especially on tweets with large media embeds.
    await page.mouse.wheel(0, 400);
    await humanWait(config.timeouts.pageLoad);

    const visibleAfterScroll = await inlineTextarea.isVisible().catch(() => false);
    if (!visibleAfterScroll) {
      return {
        success: false,
        message: 'Reply dialog did not open and inline reply composer not found',
        data: { failureCategory: 'timeout' },
      };
    }
  }

  // Type into the inline composer
  await humanType(page, inlineTextarea, content);
  await humanWait(config.timeouts.afterFill);

  // The inline submit button uses the same testid as the dialog one
  // but lives outside the dialog.  Find the tweetButton that is a
  // sibling/descendant of the inline composer's container.
  // Safest: find all tweetButtons not in a dialog.
  const inlineSubmit = page.locator(
    '[data-testid="tweetButton"]:not([role="dialog"] [data-testid="tweetButton"])',
  ).first();

  const submitVisible = await inlineSubmit.isVisible({ timeout: config.timeouts.elementWait }).catch(() => false);
  if (!submitVisible) {
    // Fallback: try the tweetButtonInline testid (used on the home compose box,
    // sometimes also for inline reply on permalink pages)
    const altSubmit = page.locator(
      '[data-testid="tweetButtonInline"]:not([role="dialog"] [data-testid="tweetButtonInline"])',
    ).first();
    const altVisible = await altSubmit.isVisible().catch(() => false);
    if (!altVisible) {
      return {
        success: false,
        message: 'Inline reply: could not find submit button',
        data: { failureCategory: 'timeout' },
      };
    }
    await humanClick(page, altSubmit);
  } else {
    const isDisabled = await inlineSubmit.getAttribute('aria-disabled');
    if (isDisabled === 'true') {
      return {
        success: false,
        message: 'Submit button disabled. Content may be empty or exceed character limit.',
        data: { failureCategory: 'submit_disabled' },
      };
    }
    await humanClick(page, inlineSubmit);
  }

  await humanWait(config.timeouts.afterSubmit);

  // Try to capture posted reply URL from toast notification
  let postedUrl: string | undefined;
  try {
    const toast = page.locator('[data-testid="toast"] a[href*="/status/"]').first();
    const toastVisible = await toast.isVisible({ timeout: 3000 }).catch(() => false);
    if (toastVisible) {
      const href = await toast.getAttribute('href');
      if (href) postedUrl = `https://x.com${href}`;
    }
  } catch {}

  return {
    success: true,
    message: `Reply posted (inline): ${content.slice(0, 50)}${content.length > 50 ? '...' : ''}`,
    data: { postedUrl },
  };
}

async function replyToTweet(input: ReplyInput): Promise<ScriptResult> {
  const { tweetUrl, content } = input;

  if (!tweetUrl) {
    return { success: false, message: 'Please provide a tweet URL' };
  }

  const validationError = validateContent(content, 'Reply');
  if (validationError) return validationError;

  let context = null;
  try {
    context = await getBrowserContext();
    const { page, success, error } = await navigateToTweet(context, tweetUrl);

    if (!success) {
      const isMissing = error?.includes('not found') || error?.includes('deleted');
      return {
        success: false,
        message: error || 'Navigation failed',
        data: { failureCategory: isMissing ? 'tweet_not_found' : 'navigation_error' },
      };
    }

    // Strategy 1: dialog-based reply
    const dialogResult = await tryDialogReply(page, content);

    if (dialogResult !== 'try_inline') {
      return dialogResult;
    }

    // Strategy 2: inline reply composer (fallback for video tweets, etc.)
    return await tryInlineReply(page, content);

  } finally {
    if (context) await context.close();
  }
}

runScript<ReplyInput>(replyToTweet);
