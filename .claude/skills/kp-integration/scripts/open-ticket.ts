#!/usr/bin/env npx tsx
/**
 * KP Integration - Open Ticket
 * Usage: echo '{"projectPath":"/path","ticketTitle":"My Ticket"}' | npx tsx open-ticket.ts
 *
 * Clicks a ticket card to open its detail modal.
 */

import { runScript, launchKp, openProject, config, DemoCursor, ScriptResult } from '../lib/browser.js';
import { selectors } from '../lib/selectors.js';

interface OpenTicketInput {
  projectPath: string;
  ticketTitle: string;
}

async function openTicket(input: OpenTicketInput): Promise<ScriptResult> {
  const { projectPath, ticketTitle } = input;

  if (!projectPath) return { success: false, message: 'Missing projectPath' };
  if (!ticketTitle) return { success: false, message: 'Missing ticketTitle' };

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

    // Dismiss any open CDK overlays (icon/type/priority pickers) that would block the click
    const overlayCount = await page.locator(selectors.overlay.pane).count();
    if (overlayCount > 0) {
      await cursor.press('Escape');
      await page.waitForTimeout(config.timeouts.afterClick);
    }

    // Click the card to open detail modal
    await cursor.click(card);

    // Wait for the ticket-detail modal to render and animation to settle (300ms modal-scale-in)
    await page.waitForSelector(selectors.ticketDetail.panel, {
      timeout: config.timeouts.elementWait,
    });
    await page.waitForTimeout(config.timeouts.modalOpen);

    return {
      success: true,
      message: `Ticket detail panel opened for "${ticketTitle}"`,
      data: { ticketTitle },
    };
  } finally {
    if (app) await app.close();
  }
}

runScript<OpenTicketInput>(openTicket);
