#!/usr/bin/env npx tsx
/**
 * X Integration - Send Direct Message
 * Usage: echo '{"username":"@levelsio","message":"Hey!"}' | npx tsx dm.ts
 *
 * Two strategies for reaching the DM composer:
 *   1. Messages-first: Navigate to x.com/messages → compose → search user → send
 *      (avoids the profile→Message click that X blocks for automated sessions)
 *   2. Profile fallback: Navigate to profile → click Message button
 *
 * Handles encrypted chat passcode prompt and X error pages.
 *
 * Returns structured failure categories in data.failureCategory:
 *   "user_not_found"    — profile doesn't exist or is suspended
 *   "dms_disabled"      — user has DMs closed / doesn't accept messages
 *   "dm_not_sent"       — message typed but send failed
 *   "timeout"           — page or element didn't load in time
 *   "passcode_failed"   — encrypted chat passcode screen could not be cleared
 *   "session_error"     — X error page, session needs refresh
 */

import { getBrowserContext, runScript, config, ScriptResult } from '../lib/browser.js';
import { humanClick, humanType, humanWait } from '../lib/human.js';
import { Page } from 'playwright';

const ENCRYPTED_CHAT_PASSCODE = '1618';

interface DmInput {
  username: string;
  message: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function findDmInput(page: Page): Promise<boolean> {
  const selectors = [
    '[data-testid="dmComposerTextInput"]',
    '[data-testid="DmComposerTextInput"]',
    '[placeholder*="message" i]',
    '[placeholder*="Message" i]',
    '[placeholder="Unencrypted message"]',
    '[role="textbox"][aria-label*="message" i]',
    '[role="textbox"][aria-label*="Message" i]',
    '[contenteditable="true"][data-testid*="dm" i]',
    '[contenteditable="true"][aria-label*="message" i]',
  ];
  for (const sel of selectors) {
    if (await page.locator(sel).first().isVisible().catch(() => false)) return true;
  }
  return false;
}

function getDmInputLocator(page: Page) {
  return page.locator([
    '[data-testid="dmComposerTextInput"]',
    '[data-testid="DmComposerTextInput"]',
    '[placeholder*="message" i]',
    '[placeholder="Unencrypted message"]',
    '[role="textbox"][aria-label*="message" i]',
    '[contenteditable="true"][aria-label*="message" i]',
  ].join(', ')).first();
}

/**
 * Verify the conversation header matches the intended recipient.
 * MUST be called before typing any message to prevent sending to wrong person.
 * Returns null if verified, or an error message if mismatched.
 */
async function verifyRecipient(page: Page, expectedUsername: string): Promise<string | null> {
  // Read conversation header — X shows the recipient's name and/or handle
  const headerSelectors = [
    '[data-testid="DMConvoHeader"]',
    '[data-testid="conversation-info"]',
    '[data-testid="DM_Conversation_Avatar"]',
    // The conversation header area typically contains the user's name
    '[data-testid="DMDrawerHeader"]',
  ];

  let headerText = '';

  // Try specific header selectors first
  for (const sel of headerSelectors) {
    const el = page.locator(sel).first();
    if (await el.isVisible().catch(() => false)) {
      headerText = await el.textContent().catch(() => '') || '';
      if (headerText.trim()) break;
    }
  }

  // Fallback: read any heading-like elements near the top of the DM panel
  if (!headerText.trim()) {
    // Look for the recipient name in the conversation — typically displayed
    // as a link or heading above the messages
    const nameSelectors = [
      'h2',
      '[role="heading"]',
      'a[href*="/' + expectedUsername + '"]',
    ];
    for (const sel of nameSelectors) {
      const el = page.locator(sel).first();
      const text = await el.textContent().catch(() => '') || '';
      if (text.trim()) {
        headerText = text;
        break;
      }
    }
  }

  // Normalize for comparison
  const normalizedHeader = headerText.toLowerCase().replace(/[^a-z0-9_]/g, '');
  const normalizedTarget = expectedUsername.toLowerCase().replace(/[^a-z0-9_]/g, '');

  // Check if the header contains the target username (handle or display name)
  if (normalizedHeader.includes(normalizedTarget)) {
    return null; // Verified
  }

  // Also check if the page URL contains a reference to the user
  const currentUrl = page.url();
  if (currentUrl.toLowerCase().includes(normalizedTarget)) {
    return null; // URL confirms correct recipient
  }

  // If header is empty, we can't verify — fail safe
  if (!headerText.trim()) {
    return `Cannot verify recipient — conversation header is empty. Expected @${expectedUsername}. Aborted to prevent sending to wrong person.`;
  }

  return `Wrong recipient — conversation shows "${headerText.trim()}", expected @${expectedUsername}. Aborted to prevent sending to wrong person.`;
}

async function isXErrorPage(page: Page): Promise<boolean> {
  // Only check for VISIBLE error elements — never raw HTML string matching,
  // because other screens (e.g. passcode) may contain CSS class names like
  // "errorContainer" in their markup without actually being error pages.
  const errorIndicators = [
    '[data-testid="error-detail"]',
    'text=/Something went wrong/i',
    'text=/Try reloading/i',
  ];
  for (const sel of errorIndicators) {
    if (await page.locator(sel).first().isVisible().catch(() => false)) return true;
  }
  return false;
}

async function isLoggedIn(page: Page): Promise<boolean> {
  const acct = await page.locator('[data-testid="SideNav_AccountSwitcher_Button"]').isVisible().catch(() => false);
  if (acct) return true;
  const login = await page.locator('input[autocomplete="username"]').isVisible().catch(() => false);
  return !login;
}

/** Click through any passcode / setup / "Start chat" screens. */
async function clearBlockingScreens(page: Page): Promise<void> {
  // Up to 3 rounds to clear chained screens
  for (let round = 0; round < 3; round++) {
    let clicked = false;

    // Step 1: Try passcode entry if digit inputs are present
    const entered = await tryEnterPasscode(page);
    if (entered) {
      await humanWait(config.timeouts.afterClick * 2);
      clicked = true;

      // After passcode entry, look EXCLUSIVELY for "Start chat" / proceed buttons.
      // Do NOT run dismiss logic (Close, Skip, etc.) — those will close the
      // post-passcode window instead of proceeding through it.
      const proceedButtons = [
        'text=/Start chat/i',
        'text=/Start Chat/i',
        'text=/New chat/i',
        'text=/New Chat/i',
        '[data-testid="ocfEnterTextNextButton"]',
        'text=/Next/i',
        'text=/Continue/i',
        'text=/Confirm/i',
        'text=/Done/i',
      ];
      for (const sel of proceedButtons) {
        const btn = page.locator(sel).first();
        if (await btn.isVisible().catch(() => false)) {
          await humanClick(page, btn);
          await humanWait(config.timeouts.afterClick * 2);
          break;
        }
      }

      // Check if DM input appeared after passcode + proceed
      if (await findDmInput(page)) return;
      continue; // Next round — don't fall through to dismiss logic
    }

    // Step 2: No passcode inputs — click setup/proceed buttons
    const setupButtons = [
      'text=/Start chat/i',
      'text=/Start Chat/i',
      'text=/Create Passcode/i',
      'text=/Set Passcode/i',
      'text=/Get Started/i',
      'text=/Enable/i',
      '[data-testid="ocfEnterTextNextButton"]',
      'text=/Next/i',
      'text=/Continue/i',
      'text=/Confirm/i',
      'text=/Submit/i',
      'text=/Done/i',
    ];
    for (const sel of setupButtons) {
      const btn = page.locator(sel).first();
      if (await btn.isVisible().catch(() => false)) {
        await humanClick(page, btn);
        await humanWait(config.timeouts.afterClick * 2);
        clicked = true;
        break;
      }
    }

    // Step 3: Only use dismiss buttons as last resort, and NEVER if
    // a "Start chat" button is visible (it would close the window
    // instead of proceeding).
    if (!clicked) {
      const startChatVisible = await page.locator('text=/Start chat/i, text=/New chat/i').first().isVisible().catch(() => false);
      if (!startChatVisible) {
        const dismissButtons = [
          'text=/Got it/i',
          'text=/OK/i',
          'text=/Skip/i',
          'text=/Maybe later/i',
          'text=/Not now/i',
          '[aria-label="Close"]',
        ];
        for (const sel of dismissButtons) {
          const btn = page.locator(sel).first();
          if (await btn.isVisible().catch(() => false)) {
            await humanClick(page, btn);
            await humanWait(config.timeouts.afterClick * 2);
            clicked = true;
            break;
          }
        }
      }
    }

    if (!clicked) break;
    if (await findDmInput(page)) return;
  }
}

async function tryEnterPasscode(page: Page): Promise<boolean> {
  const digits = ENCRYPTED_CHAT_PASSCODE.split('');
  const inputSelector = [
    'input[type="tel"]',
    'input[type="number"]',
    'input[type="password"]',
    'input[inputmode="numeric"]',
    'input[autocomplete="one-time-code"]',
    'input[maxlength="1"]',
  ].join(', ');

  let inputs = page.locator(inputSelector);
  let count = await inputs.count();

  if (count === 0) {
    try {
      await page.locator(inputSelector).first().waitFor({ timeout: 2000 });
      inputs = page.locator(inputSelector);
      count = await inputs.count();
    } catch {
      return false;
    }
  }

  if (count >= 4) {
    for (let i = 0; i < 4; i++) {
      const input = inputs.nth(i);
      await humanClick(page, input);
      await humanWait(150);
      await page.keyboard.type(digits[i]);
      await humanWait(300);
    }
    return true;
  } else if (count >= 1) {
    const firstInput = inputs.first();
    await humanClick(page, firstInput);
    await humanWait(200);
    for (const digit of digits) {
      await page.keyboard.type(digit);
      await humanWait(250);
    }
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Strategy 1: Messages-first (compose from the messages inbox)
// ---------------------------------------------------------------------------

/**
 * Navigate to x.com/messages, click the compose button, search for the user,
 * select them, and land in the DM conversation. This avoids the
 * profile → Message click entirely — which X blocks for automated sessions.
 */
async function tryMessagesCompose(page: Page, username: string): Promise<ScriptResult | 'try_profile'> {
  // Navigate to messages inbox
  await page.goto('https://x.com/messages', {
    timeout: config.timeouts.navigation,
    waitUntil: 'domcontentloaded',
  });
  await humanWait(config.timeouts.pageLoad);

  if (!(await isLoggedIn(page))) {
    return { success: false, message: 'X login expired. Run /x-integration to re-authenticate.' };
  }

  // Handle passcode/setup screens FIRST — before error page detection.
  // The passcode screen can contain CSS class names (errorContainer, etc.)
  // that would falsely trigger error page detection if checked first.
  await clearBlockingScreens(page);

  // Now check for error page — only after passcode screens have been cleared
  if (await isXErrorPage(page)) {
    return {
      success: false,
      message: 'X returned an error page on /messages — Playwright session may need re-authentication via /x-integration.',
      data: { failureCategory: 'session_error' },
    };
  }

  // Handle any remaining passcode/setup screens
  await clearBlockingScreens(page);

  // Look for the compose/new message button
  // X uses a mail/pen icon — data-testid="NewDM_Button" or aria-label with "New message"
  const composeSelectors = [
    'text=/New chat/i',
    '[data-testid="NewDM_Button"]',
    '[aria-label="New message"]',
    '[aria-label="New chat"]',
    '[aria-label="Compose a DM"]',
    '[data-testid="DM_new"]',
    'a[href="/messages/compose"]',
  ];

  let composeBtn = null;
  for (const sel of composeSelectors) {
    const loc = page.locator(sel).first();
    if (await loc.isVisible().catch(() => false)) {
      composeBtn = loc;
      break;
    }
  }

  if (!composeBtn) {
    // If we're already in a conversation view (maybe X auto-opened one),
    // check if DM input is already available
    if (await findDmInput(page)) return 'already_ready' as any;

    // Can't find compose button — fall back to profile approach
    return 'try_profile';
  }

  await humanClick(page, composeBtn);
  await humanWait(config.timeouts.afterClick * 1.5);

  // The compose flow shows a search/recipient input
  // Look for the "Search people" / recipient search input
  const searchSelectors = [
    '[data-testid="searchPeople"]',
    'input[aria-label*="Search" i]',
    'input[placeholder*="Search" i]',
    'input[data-testid="SearchBox_Search_Input"]',
  ];

  let searchInput = null;
  for (const sel of searchSelectors) {
    const loc = page.locator(sel).first();
    if (await loc.isVisible({ timeout: config.timeouts.elementWait }).catch(() => false)) {
      searchInput = loc;
      break;
    }
  }

  if (!searchInput) {
    // Compose opened but no search input — might already be in a conversation
    if (await findDmInput(page)) return 'already_ready' as any;
    return 'try_profile';
  }

  // Type the username to search
  await humanClick(page, searchInput);
  await humanWait(300);
  await humanType(page, searchInput, username);
  await humanWait(config.timeouts.afterFill * 2); // Wait for search results

  // Select the user from search results
  const resultSelectors = [
    `[data-testid="TypeaheadUser"]`,
    `[role="option"]`,
    `[data-testid="listItem"]`,
  ];

  let selectedUser = false;
  for (const sel of resultSelectors) {
    const results = page.locator(sel);
    const count = await results.count();
    if (count > 0) {
      await humanClick(page, results.first());
      await humanWait(config.timeouts.afterClick);
      selectedUser = true;
      break;
    }
  }

  if (!selectedUser) {
    // No search results — ABORT. Do not fall through to any existing
    // conversation that may be open in the sidebar.
    // Dismiss the compose dialog to clean up
    await page.keyboard.press('Escape');
    return {
      success: false,
      message: `User @${username} not found in DM search results. Aborted — no message sent.`,
      data: { failureCategory: 'user_not_found' },
    };
  }

  // After selecting the user, click "Next" to open the conversation
  const nextBtn = page.locator('[data-testid="nextButton"], text=/Next/i').first();
  if (await nextBtn.isVisible().catch(() => false)) {
    await humanClick(page, nextBtn);
    await humanWait(config.timeouts.afterClick * 1.5);
  }

  // DO NOT run clearBlockingScreens() here — the conversation window is now
  // open and its Close button would be picked up by dismiss logic, closing
  // the DM window instead of letting us type. Just wait and check for input.
  await humanWait(config.timeouts.pageLoad);

  // Check for DM input
  if (await findDmInput(page)) return 'already_ready' as any;

  // If not found yet, wait a bit longer — the conversation may still be loading
  await humanWait(config.timeouts.pageLoad);
  if (await findDmInput(page)) return 'already_ready' as any;

  return 'try_profile';
}

// ---------------------------------------------------------------------------
// Strategy 2: Profile → Message button (fallback)
// ---------------------------------------------------------------------------

async function tryProfileMessage(page: Page, username: string): Promise<ScriptResult | 'dm_ready'> {
  await page.goto(`https://x.com/${username}`, {
    timeout: config.timeouts.navigation,
    waitUntil: 'domcontentloaded',
  });
  await humanWait(config.timeouts.pageLoad);

  if (!(await isLoggedIn(page))) {
    return { success: false, message: 'X login expired. Run /x-integration to re-authenticate.' };
  }

  // Check user exists
  const doesntExist = await page.locator('text=/This account doesn.t exist/i').first().isVisible().catch(() => false);
  const isSuspended = await page.locator('text=/Account suspended/i').first().isVisible().catch(() => false);
  if (doesntExist || isSuspended) {
    return {
      success: false,
      message: `User @${username} ${isSuspended ? 'is suspended' : 'does not exist'}`,
      data: { failureCategory: 'user_not_found' },
    };
  }

  try {
    await page.locator('[data-testid="UserName"]').first().waitFor({ timeout: config.timeouts.elementWait });
  } catch {
    return {
      success: false,
      message: `Could not load profile for @${username}`,
      data: { failureCategory: 'user_not_found' },
    };
  }

  // Click Message button
  const dmButton = page.locator('[data-testid="sendDMFromProfile"]').first();
  const dmButtonAlt = page.locator('[aria-label="Message"]').first();

  let hasDmBtn = await dmButton.isVisible().catch(() => false);
  if (!hasDmBtn) hasDmBtn = await dmButtonAlt.isVisible().catch(() => false);

  if (!hasDmBtn) {
    // Try "More" menu
    const moreButton = page.locator('[data-testid="userActions"]').first();
    if (await moreButton.isVisible().catch(() => false)) {
      await humanClick(page, moreButton);
      await humanWait(config.timeouts.afterClick);
      const sendDmOption = page.locator('[data-testid="sendDMFromProfile"], text=/Send Direct Message/i').first();
      if (await sendDmOption.isVisible().catch(() => false)) {
        await humanClick(page, sendDmOption);
        await humanWait(config.timeouts.afterClick);
      } else {
        await page.keyboard.press('Escape');
        return {
          success: false,
          message: `Cannot DM @${username} — DMs appear disabled for this account`,
          data: { failureCategory: 'dms_disabled' },
        };
      }
    } else {
      return {
        success: false,
        message: `Cannot DM @${username} — no Message button on profile`,
        data: { failureCategory: 'dms_disabled' },
      };
    }
  } else {
    const btn = await dmButton.isVisible().catch(() => false) ? dmButton : dmButtonAlt;
    await humanClick(page, btn);
    await humanWait(config.timeouts.afterClick * 1.5);
  }

  // Check for error page after clicking Message
  if (await isXErrorPage(page)) {
    return {
      success: false,
      message: `X returned an error page when navigating to DM for @${username} — Playwright session may need re-authentication via /x-integration.`,
      data: { failureCategory: 'session_error' },
    };
  }

  // Handle passcode / setup screens
  await clearBlockingScreens(page);

  if (await findDmInput(page)) return 'dm_ready';

  // Can't be messaged?
  const cantMessage = await page.locator('text=/can.t be messaged/i, text=/unable to message/i').first().isVisible().catch(() => false);
  if (cantMessage) {
    return {
      success: false,
      message: `Cannot DM @${username} — this account can't be messaged`,
      data: { failureCategory: 'dms_disabled' },
    };
  }

  const bodyText = await page.locator('body').textContent().catch(() => '') || '';
  const snippet = bodyText.replace(/\s+/g, ' ').trim().slice(0, 300);
  return {
    success: false,
    message: `DM input not found for @${username}. Page: "${snippet}"`,
    data: { failureCategory: 'timeout' },
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function sendDm(input: DmInput): Promise<ScriptResult> {
  let { username, message } = input;

  if (!username) return { success: false, message: 'Please provide a username' };
  if (!message?.trim()) return { success: false, message: 'Please provide a message' };
  if (message.length > 10000) return { success: false, message: 'DM too long (max 10,000 characters)' };

  username = username.replace(/^@/, '').replace(/^https?:\/\/(www\.)?(x|twitter)\.com\//, '');

  let context = null;
  try {
    context = await getBrowserContext();
    const page = context.pages()[0] || await context.newPage();

    // --- Strategy 1: Messages inbox → compose → search → send ---
    const composeResult = await tryMessagesCompose(page, username);

    let dmReady = false;

    if (composeResult === 'already_ready' as any) {
      dmReady = true;
    } else if (composeResult === 'try_profile') {
      // Strategy 1 couldn't find compose flow — try Strategy 2
      const profileResult = await tryProfileMessage(page, username);
      if (profileResult === 'dm_ready') {
        dmReady = true;
      } else {
        return profileResult; // Error result
      }
    } else if (typeof composeResult === 'object' && 'success' in composeResult) {
      // Got an error result from strategy 1
      if (composeResult.data?.failureCategory === 'session_error') {
        // Session is broken — don't bother with strategy 2
        return composeResult;
      }
      // Try strategy 2 as fallback
      const profileResult = await tryProfileMessage(page, username);
      if (profileResult === 'dm_ready') {
        dmReady = true;
      } else {
        return profileResult;
      }
    }

    if (!dmReady) {
      return {
        success: false,
        message: `Could not reach DM composer for @${username}`,
        data: { failureCategory: 'timeout' },
      };
    }

    // --- SAFETY: Verify recipient before typing anything ---
    const recipientError = await verifyRecipient(page, username);
    if (recipientError) {
      return {
        success: false,
        message: recipientError,
        data: { failureCategory: 'wrong_recipient' },
      };
    }

    // --- Type and send the message ---
    const dmInput = getDmInputLocator(page);
    await humanType(page, dmInput, message);
    await humanWait(config.timeouts.afterFill);

    // Send
    const sendButton = page.locator('[data-testid="dmComposerSendButton"]').first();
    if (await sendButton.isVisible().catch(() => false)) {
      await humanClick(page, sendButton);
    } else {
      const altSend = page.locator('[aria-label="Send"]').first();
      if (await altSend.isVisible().catch(() => false)) {
        await humanClick(page, altSend);
      } else {
        await page.keyboard.press('Enter');
      }
    }

    await humanWait(config.timeouts.afterSubmit);

    // Verify send
    const inputTextAfter = await dmInput.textContent().catch(() => '') || '';
    if (inputTextAfter.includes(message.slice(0, 20))) {
      return {
        success: false,
        message: `DM to @${username} may not have been sent — message still in input`,
        data: { failureCategory: 'dm_not_sent' },
      };
    }

    return {
      success: true,
      message: `DM sent to @${username}: ${message.slice(0, 50)}${message.length > 50 ? '...' : ''}`,
    };

  } finally {
    if (context) await context.close();
  }
}

runScript<DmInput>(sendDm);
