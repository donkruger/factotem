#!/usr/bin/env npx tsx
/**
 * KP Integration - Open Project
 * Usage: echo '{"projectPath":"/path/to/demo"}' | npx tsx open-project.ts
 *
 * Launches KP and opens a project folder.
 */

import { runScript, launchKp, openProject, config, ScriptResult } from '../lib/browser.js';

interface OpenProjectInput {
  projectPath: string;
}

async function openProjectHandler(input: OpenProjectInput): Promise<ScriptResult> {
  const { projectPath } = input;

  if (!projectPath) {
    return { success: false, message: 'Missing projectPath' };
  }

  let app = null;
  try {
    const result = await launchKp();
    app = result.app;
    const { page, cursor } = result;

    await openProject(app, page, projectPath, cursor);

    // Verify board is fully rendered (at least one column must be present)
    const boardVisible = await page.locator('kanban-board kanban-column').first().isVisible().catch(() => false);
    if (!boardVisible) {
      return { success: false, message: 'KP launched but board columns did not appear' };
    }

    return {
      success: true,
      message: `KP launched and project opened: ${projectPath}`,
    };
  } finally {
    if (app) await app.close();
  }
}

runScript<OpenProjectInput>(openProjectHandler);
