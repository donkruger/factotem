#!/usr/bin/env npx tsx
/**
 * KP Integration - Move Ticket
 * Usage: echo '{"projectPath":"/path","ticketTitle":"My Ticket","targetColumnIndex":1}' | npx tsx move-ticket.ts
 *
 * Drags a ticket card to a different column using CDK drag-drop.
 * CDK uses pointer events (pointerdown/pointermove/pointerup). The sequence
 * includes an initial small offset move to pass CDK's drag start threshold.
 */

import { runScript, launchKp, openProject, config, DemoCursor, ScriptResult } from '../lib/browser.js';
import { selectors } from '../lib/selectors.js';

interface MoveTicketInput {
  projectPath: string;
  ticketTitle: string;
  targetColumnIndex: number;
}

async function moveTicket(input: MoveTicketInput): Promise<ScriptResult> {
  const { projectPath, ticketTitle, targetColumnIndex } = input;

  if (!projectPath) return { success: false, message: 'Missing projectPath' };
  if (!ticketTitle) return { success: false, message: 'Missing ticketTitle' };
  if (targetColumnIndex === undefined) return { success: false, message: 'Missing targetColumnIndex' };

  let app = null;
  try {
    const result = await launchKp();
    app = result.app;
    const { page, cursor } = result;

    await openProject(app, page, projectPath, cursor);

    // Find the card by title
    const card = page.locator(`${selectors.board.card}:has-text("${ticketTitle}")`);
    const cardVisible = await card.isVisible({ timeout: config.timeouts.elementWait }).catch(() => false);
    if (!cardVisible) {
      return { success: false, message: `Ticket "${ticketTitle}" not found on the board` };
    }

    // Get target column
    const columns = page.locator(selectors.board.column);
    const columnCount = await columns.count();
    if (targetColumnIndex >= columnCount) {
      return {
        success: false,
        message: `Column index ${targetColumnIndex} out of range (${columnCount} columns available)`,
      };
    }
    const targetColumn = columns.nth(targetColumnIndex);

    // Get bounding boxes for drag source and target
    const cardBox = await card.boundingBox();
    const targetBox = await targetColumn.boundingBox();
    if (!cardBox || !targetBox) {
      return { success: false, message: 'Could not determine card or column position' };
    }

    const srcX = cardBox.x + cardBox.width / 2;
    const srcY = cardBox.y + cardBox.height / 2;
    const tgtX = targetBox.x + targetBox.width / 2;
    const tgtY = targetBox.y + 50; // drop near top of target column

    // Move cursor to the card, press down, drag to target
    await cursor.move(srcX, srcY);
    await cursor.down();
    // Small initial move to pass CDK's drag start threshold
    await cursor.move(srcX + 10, srcY + 10, { steps: 5 });
    // Move to target column in steps so CDK registers the drop zone
    await cursor.move(tgtX, tgtY, { steps: 10 });
    // Brief pause to let CDK register the drop target
    await page.waitForTimeout(100);
    await cursor.up();

    // Wait for CDK drag animation to complete (250ms transform + buffer)
    await page.locator(selectors.drag.animating)
      .waitFor({ state: 'detached', timeout: 2000 })
      .catch(() => {}); // may already be detached
    await page.waitForTimeout(config.timeouts.afterDrag);

    // Verify the card is now in the target column
    const movedCard = targetColumn.locator(`${selectors.board.card}:has-text("${ticketTitle}")`);
    const moved = await movedCard.isVisible({ timeout: config.timeouts.elementWait }).catch(() => false);

    if (!moved) {
      return {
        success: false,
        message: `Drag completed but ticket "${ticketTitle}" not found in target column ${targetColumnIndex}. CDK may require data-testid attributes for reliable drag-drop.`,
      };
    }

    return {
      success: true,
      message: `Ticket "${ticketTitle}" moved to column ${targetColumnIndex}`,
      data: { ticketTitle, targetColumnIndex },
    };
  } finally {
    if (app) await app.close();
  }
}

runScript<MoveTicketInput>(moveTicket);
