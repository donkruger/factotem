#!/usr/bin/env npx tsx
/**
 * KP Integration - Update Field
 * Usage: echo '{"projectPath":"/path","ticketTitle":"My Ticket","field":"title","value":"New Title"}' | npx tsx update-field.ts
 *
 * Opens a ticket and edits a field. KP auto-saves via 1000ms debounce.
 * Supported fields: title, description, tags.
 */

import { runScript, launchKp, openProject, config, DemoCursor, ScriptResult } from '../lib/browser.js';
import { selectors } from '../lib/selectors.js';

interface UpdateFieldInput {
  projectPath: string;
  ticketTitle: string;
  field: 'title' | 'description' | 'tags';
  value: string;
}

async function updateField(input: UpdateFieldInput): Promise<ScriptResult> {
  const { projectPath, ticketTitle, field, value } = input;

  if (!projectPath) return { success: false, message: 'Missing projectPath' };
  if (!ticketTitle) return { success: false, message: 'Missing ticketTitle' };
  if (!field) return { success: false, message: 'Missing field' };
  if (!value) return { success: false, message: 'Missing value' };

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

    // Edit the field based on type
    switch (field) {
      case 'title': {
        const titleInput = page.locator(selectors.ticketDetail.titleInput);
        await cursor.click(titleInput, { clickCount: 3 }); // Select all
        await cursor.type(value);
        // Tab to blur — save fires on input event with 1000ms debounce
        await cursor.press('Tab');
        break;
      }

      case 'description': {
        // ProseMirror contenteditable — page.fill() does NOT work here.
        // Use click + keyboard.type() instead.
        const editor = page.locator(selectors.ticketDetail.editor);
        await cursor.click(editor);
        // Select all existing content and replace
        await cursor.press('Meta+a');
        await cursor.type(value);
        // Click the title input to blur the editor and trigger save.
        // IMPORTANT: Do NOT press Escape — it's a global shortcut that closes the modal.
        await cursor.click(page.locator(selectors.ticketDetail.titleInput));
        break;
      }

      case 'tags': {
        const tagInput = page.locator(selectors.ticketDetail.tagInput);
        await cursor.click(tagInput);
        const input = tagInput.locator('input');
        await cursor.click(input);
        await cursor.type(value);
        await page.waitForTimeout(100); // let suggestion dropdown render
        await cursor.press('Enter');
        break;
      }
    }

    // Wait for KP's debounced auto-save (1000ms debounce + buffer)
    await page.waitForTimeout(config.timeouts.debounceSave);

    return {
      success: true,
      message: `Updated ${field} to "${value.slice(0, 50)}${value.length > 50 ? '...' : ''}" on ticket "${ticketTitle}"`,
      data: { ticketTitle, field, value },
    };
  } finally {
    if (app) await app.close();
  }
}

runScript<UpdateFieldInput>(updateField);
