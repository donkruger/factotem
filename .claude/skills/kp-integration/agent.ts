/**
 * KP Integration - MCP Tool Definitions (Agent/Container Side)
 *
 * These tools run inside the container and communicate with the host via IPC.
 * The host-side implementation is in src/skills/kp-handler.ts.
 *
 * Note: This file is compiled in the container, not on the host.
 * The @ts-ignore is needed because the SDK is only available in the container.
 */

// @ts-ignore - SDK available in container environment only
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';

// IPC directories (inside container)
const IPC_DIR = '/workspace/ipc';
const TASKS_DIR = path.join(IPC_DIR, 'tasks');
const RESULTS_DIR = path.join(IPC_DIR, 'kp_results');

function writeIpcFile(dir: string, data: object): string {
  fs.mkdirSync(dir, { recursive: true });
  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(dir, filename);
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filepath);
  return filename;
}

async function waitForResult(requestId: string, maxWait = 60000): Promise<{ success: boolean; message: string }> {
  const resultFile = path.join(RESULTS_DIR, `${requestId}.json`);
  const pollInterval = 1000;
  let elapsed = 0;

  while (elapsed < maxWait) {
    if (fs.existsSync(resultFile)) {
      try {
        const result = JSON.parse(fs.readFileSync(resultFile, 'utf-8'));
        fs.unlinkSync(resultFile);
        return result;
      } catch (err) {
        return { success: false, message: `Failed to read result: ${err}` };
      }
    }
    await new Promise(resolve => setTimeout(resolve, pollInterval));
    elapsed += pollInterval;
  }

  return { success: false, message: 'Request timed out' };
}

export interface SkillToolsContext {
  groupFolder: string;
  isMain: boolean;
}

/**
 * Create KP integration MCP tools
 */
export function createKpTools(ctx: SkillToolsContext) {
  const { groupFolder, isMain } = ctx;

  return [
    tool(
      'kp_open_project',
      `Launch Kanban Pro and open a project folder. Main group only.
Use this before any other kp_* tool if KP isn't already open.`,
      {
        project_path: z.string().describe('Absolute path to the KP project folder'),
      },
      async (args: { project_path: string }) => {
        if (!isMain) {
          return { content: [{ type: 'text', text: 'Only the main group can control KP.' }], isError: true };
        }

        const requestId = `kp-openproj-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        writeIpcFile(TASKS_DIR, {
          type: 'kp_open_project',
          requestId,
          projectPath: args.project_path,
          groupFolder,
          timestamp: new Date().toISOString(),
        });

        const result = await waitForResult(requestId, 30000);
        return { content: [{ type: 'text', text: result.message }], isError: !result.success };
      }
    ),

    tool(
      'kp_create_ticket',
      `Create a new ticket in Kanban Pro. Main group only.
Opens the KP app, navigates to the project, and creates a ticket in the specified column.`,
      {
        project_path: z.string().describe('Absolute path to the KP project folder'),
        title: z.string().describe('The ticket title'),
        column_index: z.number().min(0).optional().describe('Column index (0-based, default: 0 = first column)'),
      },
      async (args: { project_path: string; title: string; column_index?: number }) => {
        if (!isMain) {
          return { content: [{ type: 'text', text: 'Only the main group can control KP.' }], isError: true };
        }

        const requestId = `kp-create-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        writeIpcFile(TASKS_DIR, {
          type: 'kp_create_ticket',
          requestId,
          projectPath: args.project_path,
          title: args.title,
          columnIndex: args.column_index ?? 0,
          groupFolder,
          timestamp: new Date().toISOString(),
        });

        const result = await waitForResult(requestId);
        return { content: [{ type: 'text', text: result.message }], isError: !result.success };
      }
    ),

    tool(
      'kp_move_ticket',
      `Move a ticket card to a different column in Kanban Pro. Main group only.
Drags the card from its current column to the target column.`,
      {
        project_path: z.string().describe('Absolute path to the KP project folder'),
        ticket_title: z.string().describe('Title of the ticket to move'),
        target_column_index: z.number().min(0).describe('Target column index (0-based)'),
      },
      async (args: { project_path: string; ticket_title: string; target_column_index: number }) => {
        if (!isMain) {
          return { content: [{ type: 'text', text: 'Only the main group can control KP.' }], isError: true };
        }

        const requestId = `kp-move-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        writeIpcFile(TASKS_DIR, {
          type: 'kp_move_ticket',
          requestId,
          projectPath: args.project_path,
          ticketTitle: args.ticket_title,
          targetColumnIndex: args.target_column_index,
          groupFolder,
          timestamp: new Date().toISOString(),
        });

        const result = await waitForResult(requestId);
        return { content: [{ type: 'text', text: result.message }], isError: !result.success };
      }
    ),

    tool(
      'kp_open_ticket',
      `Open a ticket's detail panel in Kanban Pro. Main group only.`,
      {
        project_path: z.string().describe('Absolute path to the KP project folder'),
        ticket_title: z.string().describe('Title of the ticket to open'),
      },
      async (args: { project_path: string; ticket_title: string }) => {
        if (!isMain) {
          return { content: [{ type: 'text', text: 'Only the main group can control KP.' }], isError: true };
        }

        const requestId = `kp-open-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        writeIpcFile(TASKS_DIR, {
          type: 'kp_open_ticket',
          requestId,
          projectPath: args.project_path,
          ticketTitle: args.ticket_title,
          groupFolder,
          timestamp: new Date().toISOString(),
        });

        const result = await waitForResult(requestId);
        return { content: [{ type: 'text', text: result.message }], isError: !result.success };
      }
    ),

    tool(
      'kp_update_field',
      `Edit a field on an open ticket in Kanban Pro. Main group only.
Supported fields: title, description, tags.`,
      {
        project_path: z.string().describe('Absolute path to the KP project folder'),
        ticket_title: z.string().describe('Title of the ticket to edit'),
        field: z.enum(['title', 'description', 'tags']).describe('Field to edit'),
        value: z.string().describe('New value for the field'),
      },
      async (args: { project_path: string; ticket_title: string; field: string; value: string }) => {
        if (!isMain) {
          return { content: [{ type: 'text', text: 'Only the main group can control KP.' }], isError: true };
        }

        const requestId = `kp-update-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        writeIpcFile(TASKS_DIR, {
          type: 'kp_update_field',
          requestId,
          projectPath: args.project_path,
          ticketTitle: args.ticket_title,
          field: args.field,
          value: args.value,
          groupFolder,
          timestamp: new Date().toISOString(),
        });

        const result = await waitForResult(requestId);
        return { content: [{ type: 'text', text: result.message }], isError: !result.success };
      }
    ),

    tool(
      'kp_switch_view',
      `Switch between views in Kanban Pro. Main group only.
Available views: board, list, table, calendar, gantt.`,
      {
        project_path: z.string().describe('Absolute path to the KP project folder'),
        view: z.enum(['board', 'list', 'table', 'calendar', 'gantt']).describe('Target view'),
      },
      async (args: { project_path: string; view: string }) => {
        if (!isMain) {
          return { content: [{ type: 'text', text: 'Only the main group can control KP.' }], isError: true };
        }

        const requestId = `kp-view-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        writeIpcFile(TASKS_DIR, {
          type: 'kp_switch_view',
          requestId,
          projectPath: args.project_path,
          view: args.view,
          groupFolder,
          timestamp: new Date().toISOString(),
        });

        const result = await waitForResult(requestId);
        return { content: [{ type: 'text', text: result.message }], isError: !result.success };
      }
    ),

    tool(
      'kp_search',
      `Search for tickets in Kanban Pro using Cmd+K. Main group only.`,
      {
        project_path: z.string().describe('Absolute path to the KP project folder'),
        query: z.string().describe('Search query'),
        select_first: z.boolean().optional().describe('Click the first result (default: false)'),
      },
      async (args: { project_path: string; query: string; select_first?: boolean }) => {
        if (!isMain) {
          return { content: [{ type: 'text', text: 'Only the main group can control KP.' }], isError: true };
        }

        const requestId = `kp-search-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        writeIpcFile(TASKS_DIR, {
          type: 'kp_search',
          requestId,
          projectPath: args.project_path,
          query: args.query,
          selectFirst: args.select_first ?? false,
          groupFolder,
          timestamp: new Date().toISOString(),
        });

        const result = await waitForResult(requestId);
        return { content: [{ type: 'text', text: result.message }], isError: !result.success };
      }
    ),

    tool(
      'kp_add_comment',
      `Add a comment to a ticket in Kanban Pro. Main group only.`,
      {
        project_path: z.string().describe('Absolute path to the KP project folder'),
        ticket_title: z.string().describe('Title of the ticket'),
        comment: z.string().describe('Comment text to add'),
      },
      async (args: { project_path: string; ticket_title: string; comment: string }) => {
        if (!isMain) {
          return { content: [{ type: 'text', text: 'Only the main group can control KP.' }], isError: true };
        }

        const requestId = `kp-comment-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        writeIpcFile(TASKS_DIR, {
          type: 'kp_add_comment',
          requestId,
          projectPath: args.project_path,
          ticketTitle: args.ticket_title,
          comment: args.comment,
          groupFolder,
          timestamp: new Date().toISOString(),
        });

        const result = await waitForResult(requestId);
        return { content: [{ type: 'text', text: result.message }], isError: !result.success };
      }
    ),
  ];
}
