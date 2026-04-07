#!/usr/bin/env npx tsx
/**
 * KP Integration - Create Ticket
 * Usage: echo '{"projectPath":"/path","title":"My Ticket","columnIndex":0}' | npx tsx create-ticket.ts
 *
 * Creates a new ticket in the specified column via the add-ticket input.
 * KP auto-creates a .md file in the tickets/ folder on disk.
 */

import { runScript, launchKp, openProject, config, DemoCursor, ScriptResult } from '../lib/browser.js';
import { selectors } from '../lib/selectors.js';

interface CreateTicketInput {
  projectPath: string;
  columnIndex?: number;
  title: string;
}

async function createTicket(input: CreateTicketInput): Promise<ScriptResult> {
  const { projectPath, title, columnIndex = 0 } = input;

  if (!projectPath) return { success: false, message: 'Missing projectPath' };
  if (!title) return { success: false, message: 'Missing title' };

  let app = null;
  try {
    const result = await launchKp();
    app = result.app;
    const { page, cursor } = result;

    await openProject(app, page, projectPath, cursor);

    // Locate the target column
    const columns = page.locator(selectors.board.column);
    const columnCount = await columns.count();
    if (columnIndex >= columnCount) {
      return {
        success: false,
        message: `Column index ${columnIndex} out of range (${columnCount} columns available)`,
      };
    }
    const targetColumn = columns.nth(columnIndex);

    // Find and click the add-ticket input inside that column
    const addInput = targetColumn.locator(selectors.board.addTicketInput);
    await cursor.click(addInput);
    await cursor.type(title);
    await cursor.press('Enter');

    // Wait for the new card to appear
    await page.waitForTimeout(config.timeouts.afterClick);
    const newCard = targetColumn.locator(selectors.board.card, { hasText: title });
    const appeared = await newCard.isVisible({ timeout: config.timeouts.elementWait }).catch(() => false);

    if (!appeared) {
      return {
        success: false,
        message: `Ticket "${title}" was submitted but card did not appear on the board`,
      };
    }

    return {
      success: true,
      message: `Ticket created: "${title}" in column ${columnIndex}`,
      data: { title, columnIndex },
    };
  } finally {
    if (app) await app.close();
  }
}

runScript<CreateTicketInput>(createTicket);
