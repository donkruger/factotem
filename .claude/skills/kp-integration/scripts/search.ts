#!/usr/bin/env npx tsx
/**
 * KP Integration - Search
 * Usage: echo '{"projectPath":"/path","query":"bug fix","selectFirst":true}' | npx tsx search.ts
 *
 * Opens KP's Cmd+K search, types a query, and optionally selects the first result.
 */

import { runScript, launchKp, openProject, config, DemoCursor, ScriptResult } from '../lib/browser.js';
import { selectors } from '../lib/selectors.js';

interface SearchInput {
  projectPath: string;
  query: string;
  selectFirst?: boolean;
}

async function search(input: SearchInput): Promise<ScriptResult> {
  const { projectPath, query, selectFirst = false } = input;

  if (!projectPath) return { success: false, message: 'Missing projectPath' };
  if (!query) return { success: false, message: 'Missing query' };

  let app = null;
  try {
    const result = await launchKp();
    app = result.app;
    const { page, cursor } = result;

    await openProject(app, page, projectPath, cursor);

    // Open search with Cmd+K
    await cursor.press('Meta+k');
    await page.waitForSelector(selectors.search.input, {
      timeout: config.timeouts.elementWait,
    });

    // Type the search query
    const searchInput = page.locator(selectors.search.input);
    await cursor.click(searchInput);
    await cursor.type(query);
    await page.waitForTimeout(config.timeouts.afterType);

    // Count results
    const resultItems = page.locator(selectors.search.resultItem);
    const resultCount = await resultItems.count().catch(() => 0);

    if (selectFirst && resultCount > 0) {
      await cursor.press('Enter');
      await page.waitForTimeout(config.timeouts.animationSettle);

      return {
        success: true,
        message: `Search for "${query}" — selected first result (${resultCount} total)`,
        data: { query, resultCount, selectedFirst: true },
      };
    }

    return {
      success: true,
      message: `Search for "${query}" — ${resultCount} result(s) found`,
      data: { query, resultCount, selectedFirst: false },
    };
  } finally {
    if (app) await app.close();
  }
}

runScript<SearchInput>(search);
