#!/usr/bin/env npx tsx
/**
 * KP Integration - Add Comment
 * Usage: echo '{"projectPath":"/path","ticketTitle":"My Ticket","comment":"Looks good!"}' | npx tsx add-comment.ts
 *
 * Opens a ticket and adds a comment in the comment section.
 */

import { runScript, launchKp, openProject, config, DemoCursor, ScriptResult } from '../lib/browser.js';
import { selectors } from '../lib/selectors.js';

interface AddCommentInput {
  projectPath: string;
  ticketTitle: string;
  comment: string;
}

async function addComment(input: AddCommentInput): Promise<ScriptResult> {
  const { projectPath, ticketTitle, comment } = input;

  if (!projectPath) return { success: false, message: 'Missing projectPath' };
  if (!ticketTitle) return { success: false, message: 'Missing ticketTitle' };
  if (!comment) return { success: false, message: 'Missing comment' };

  let app = null;
  try {
    const result = await launchKp();
    app = result.app;
    const { page, cursor } = result;

    await openProject(app, page, projectPath, cursor);

    // Open the ticket detail modal
    const card = page.locator(`${selectors.board.card}:has-text("${ticketTitle}")`);
    const cardVisible = await card.isVisible({ timeout: config.timeouts.elementWait }).catch(() => false);
    if (!cardVisible) {
      return { success: false, message: `Ticket "${ticketTitle}" not found on the board` };
    }
    await cursor.click(card);
    await page.waitForSelector(selectors.ticketDetail.panel, {
      timeout: config.timeouts.elementWait,
    });
    await page.waitForTimeout(config.timeouts.modalOpen);

    // Scroll to the comment area at the bottom of the detail modal
    const scrollContainer = page.locator(selectors.ticketDetail.scrollBody).first();
    await scrollContainer.evaluate(el => el.scrollTop = el.scrollHeight);
    await page.waitForTimeout(config.timeouts.afterClick);

    // Find the comment editor — ProseMirror contenteditable.
    // page.fill() does NOT work here — use click + keyboard.type().
    const commentEditor = page.locator('.comment-editor-area .ProseMirror, .comment-editor-area .tiptap');
    const editorVisible = await commentEditor.first().isVisible({ timeout: config.timeouts.elementWait }).catch(() => false);

    if (!editorVisible) {
      // Comment editor may be collapsed — scroll the submit button into view to activate
      const submitBtn = page.locator(selectors.ticketDetail.commentSubmit);
      await submitBtn.scrollIntoViewIfNeeded();
      await page.waitForTimeout(config.timeouts.afterClick);
    }

    // Type the comment
    await cursor.click(commentEditor.first());
    await cursor.type(comment);
    await page.waitForTimeout(config.timeouts.afterType);

    // Submit via the dedicated submit button (not Enter — Tiptap uses Enter for newlines)
    const submitBtn = page.locator(selectors.ticketDetail.commentSubmit);
    await cursor.click(submitBtn);
    await page.waitForTimeout(config.timeouts.afterClick);

    return {
      success: true,
      message: `Comment added to "${ticketTitle}": "${comment.slice(0, 50)}${comment.length > 50 ? '...' : ''}"`,
      data: { ticketTitle, comment },
    };
  } finally {
    if (app) await app.close();
  }
}

runScript<AddCommentInput>(addComment);
