#!/usr/bin/env npx tsx
/**
 * KP Integration - Switch View
 * Usage: echo '{"projectPath":"/path","view":"list"}' | npx tsx switch-view.ts
 *
 * Switches between KP views: board, list, table, calendar, gantt.
 * Views are rendered as buttons in order in the view switcher bar.
 */

import { runScript, launchKp, openProject, config, DemoCursor, ScriptResult } from '../lib/browser.js';
import { selectors } from '../lib/selectors.js';

interface SwitchViewInput {
  projectPath: string;
  view: 'board' | 'list' | 'table' | 'calendar' | 'gantt';
}

const VIEW_ORDER = ['board', 'list', 'table', 'calendar', 'gantt'] as const;

async function switchView(input: SwitchViewInput): Promise<ScriptResult> {
  const { projectPath, view } = input;

  if (!projectPath) return { success: false, message: 'Missing projectPath' };
  if (!view) return { success: false, message: 'Missing view' };

  const index = VIEW_ORDER.indexOf(view);
  if (index === -1) {
    return { success: false, message: `Invalid view: ${view}. Must be one of: ${VIEW_ORDER.join(', ')}` };
  }

  let app = null;
  try {
    const result = await launchKp();
    app = result.app;
    const { page, cursor } = result;

    await openProject(app, page, projectPath, cursor);

    // Click the view switcher button by data-testid
    const viewBtn = page.locator(selectors.viewSwitcher.byView(view));
    const btnVisible = await viewBtn.isVisible({ timeout: config.timeouts.elementWait }).catch(() => false);
    if (!btnVisible) {
      // Fall back to nth-index if data-testid not present
      const fallbackBtn = page.locator(selectors.viewSwitcher.button).nth(index);
      const fallbackVisible = await fallbackBtn.isVisible({ timeout: config.timeouts.elementWait }).catch(() => false);
      if (!fallbackVisible) {
        return { success: false, message: `View switcher button for "${view}" not found` };
      }
      await cursor.click(fallbackBtn);
    } else {
      await cursor.click(viewBtn);
    }
    await page.waitForTimeout(config.timeouts.animationSettle);

    return {
      success: true,
      message: `Switched to ${view} view`,
      data: { view },
    };
  } finally {
    if (app) await app.close();
  }
}

runScript<SwitchViewInput>(switchView);
