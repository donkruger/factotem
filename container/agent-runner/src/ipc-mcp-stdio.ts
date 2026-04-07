/**
 * Stdio MCP Server for NanoClaw
 * Standalone process that agent teams subagents can inherit.
 * Reads context from environment variables, writes IPC files for the host.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { CronExpressionParser } from 'cron-parser';

const IPC_DIR = '/workspace/ipc';
const MESSAGES_DIR = path.join(IPC_DIR, 'messages');
const TASKS_DIR = path.join(IPC_DIR, 'tasks');

// Context from environment variables (set by the agent runner)
const chatJid = process.env.NANOCLAW_CHAT_JID!;
const groupFolder = process.env.NANOCLAW_GROUP_FOLDER!;
const isMain = process.env.NANOCLAW_IS_MAIN === '1';

function writeIpcFile(dir: string, data: object): string {
  fs.mkdirSync(dir, { recursive: true });

  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(dir, filename);

  // Atomic write: temp file then rename
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filepath);

  return filename;
}

const server = new McpServer({
  name: 'nanoclaw',
  version: '1.0.0',
});

server.tool(
  'send_message',
  `Send a message to the user or group immediately while you're still running. Use this for progress updates or to send multiple messages. You can call this multiple times.

From the main group you can send direct messages to any registered chat by specifying target_jid (e.g. "27845553333@s.whatsapp.net" for a WhatsApp DM). Non-main groups can only message their own chat.`,
  {
    text: z.string().describe('The message text to send'),
    sender: z.string().optional().describe('Your role/identity name (e.g. "Researcher"). When set, messages appear from a dedicated bot in Telegram.'),
    target_jid: z.string().optional().describe('(Main group only) JID to send the message to. Defaults to the current chat. Use for cross-chat or direct messages.'),
  },
  async (args) => {
    const targetJid = isMain && args.target_jid ? args.target_jid : chatJid;

    const data: Record<string, string | undefined> = {
      type: 'message',
      chatJid: targetJid,
      text: args.text,
      sender: args.sender || undefined,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(MESSAGES_DIR, data);

    return { content: [{ type: 'text' as const, text: `Message sent${targetJid !== chatJid ? ` to ${targetJid}` : ''}.` }] };
  },
);

server.tool(
  'schedule_task',
  `Schedule a recurring or one-time task. The task will run as a full agent with access to all tools. Returns the task ID for future reference. To modify an existing task, use update_task instead.

CONTEXT MODE - Choose based on task type:
\u2022 "group": Task runs in the group's conversation context, with access to chat history. Use for tasks that need context about ongoing discussions, user preferences, or recent interactions.
\u2022 "isolated": Task runs in a fresh session with no conversation history. Use for independent tasks that don't need prior context. When using isolated mode, include all necessary context in the prompt itself.

If unsure which mode to use, you can ask the user. Examples:
- "Remind me about our discussion" \u2192 group (needs conversation context)
- "Check the weather every morning" \u2192 isolated (self-contained task)
- "Follow up on my request" \u2192 group (needs to know what was requested)
- "Generate a daily report" \u2192 isolated (just needs instructions in prompt)

MESSAGING BEHAVIOR - The task agent's output is sent to the user or group. It can also use send_message for immediate delivery, or wrap output in <internal> tags to suppress it. Include guidance in the prompt about whether the agent should:
\u2022 Always send a message (e.g., reminders, daily briefings)
\u2022 Only send a message when there's something to report (e.g., "notify me if...")
\u2022 Never send a message (background maintenance tasks)

SCHEDULE VALUE FORMAT (all times are LOCAL timezone):
\u2022 cron: Standard cron expression (e.g., "*/5 * * * *" for every 5 minutes, "0 9 * * *" for daily at 9am LOCAL time)
\u2022 interval: Milliseconds between runs (e.g., "300000" for 5 minutes, "3600000" for 1 hour)
\u2022 once: Local time WITHOUT "Z" suffix (e.g., "2026-02-01T15:30:00"). Do NOT use UTC/Z suffix.`,
  {
    prompt: z.string().describe('What the agent should do when the task runs. For isolated mode, include all necessary context here.'),
    schedule_type: z.enum(['cron', 'interval', 'once']).describe('cron=recurring at specific times, interval=recurring every N ms, once=run once at specific time'),
    schedule_value: z.string().describe('cron: "*/5 * * * *" | interval: milliseconds like "300000" | once: local timestamp like "2026-02-01T15:30:00" (no Z suffix!)'),
    context_mode: z.enum(['group', 'isolated']).default('group').describe('group=runs with chat history and memory, isolated=fresh session (include context in prompt)'),
    target_group_jid: z.string().optional().describe('(Main group only) JID of the group to schedule the task for. Defaults to the current group.'),
  },
  async (args) => {
    // Validate schedule_value before writing IPC
    if (args.schedule_type === 'cron') {
      try {
        CronExpressionParser.parse(args.schedule_value);
      } catch {
        return {
          content: [{ type: 'text' as const, text: `Invalid cron: "${args.schedule_value}". Use format like "0 9 * * *" (daily 9am) or "*/5 * * * *" (every 5 min).` }],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'interval') {
      const ms = parseInt(args.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        return {
          content: [{ type: 'text' as const, text: `Invalid interval: "${args.schedule_value}". Must be positive milliseconds (e.g., "300000" for 5 min).` }],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'once') {
      if (/[Zz]$/.test(args.schedule_value) || /[+-]\d{2}:\d{2}$/.test(args.schedule_value)) {
        return {
          content: [{ type: 'text' as const, text: `Timestamp must be local time without timezone suffix. Got "${args.schedule_value}" — use format like "2026-02-01T15:30:00".` }],
          isError: true,
        };
      }
      const date = new Date(args.schedule_value);
      if (isNaN(date.getTime())) {
        return {
          content: [{ type: 'text' as const, text: `Invalid timestamp: "${args.schedule_value}". Use local time format like "2026-02-01T15:30:00".` }],
          isError: true,
        };
      }
    }

    // Non-main groups can only schedule for themselves
    const targetJid = isMain && args.target_group_jid ? args.target_group_jid : chatJid;

    const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const data = {
      type: 'schedule_task',
      taskId,
      prompt: args.prompt,
      schedule_type: args.schedule_type,
      schedule_value: args.schedule_value,
      context_mode: args.context_mode || 'group',
      targetJid,
      createdBy: groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `Task ${taskId} scheduled: ${args.schedule_type} - ${args.schedule_value}` }],
    };
  },
);

server.tool(
  'list_tasks',
  "List all scheduled tasks. From main: shows all tasks. From other groups: shows only that group's tasks.",
  {},
  async () => {
    const tasksFile = path.join(IPC_DIR, 'current_tasks.json');

    try {
      if (!fs.existsSync(tasksFile)) {
        return { content: [{ type: 'text' as const, text: 'No scheduled tasks found.' }] };
      }

      const allTasks = JSON.parse(fs.readFileSync(tasksFile, 'utf-8'));

      const tasks = isMain
        ? allTasks
        : allTasks.filter((t: { groupFolder: string }) => t.groupFolder === groupFolder);

      if (tasks.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No scheduled tasks found.' }] };
      }

      const formatted = tasks
        .map(
          (t: { id: string; prompt: string; schedule_type: string; schedule_value: string; status: string; next_run: string }) =>
            `- [${t.id}] ${t.prompt.slice(0, 50)}... (${t.schedule_type}: ${t.schedule_value}) - ${t.status}, next: ${t.next_run || 'N/A'}`,
        )
        .join('\n');

      return { content: [{ type: 'text' as const, text: `Scheduled tasks:\n${formatted}` }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error reading tasks: ${err instanceof Error ? err.message : String(err)}` }],
      };
    }
  },
);

server.tool(
  'pause_task',
  'Pause a scheduled task. It will not run until resumed.',
  { task_id: z.string().describe('The task ID to pause') },
  async (args) => {
    const data = {
      type: 'pause_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} pause requested.` }] };
  },
);

server.tool(
  'resume_task',
  'Resume a paused task.',
  { task_id: z.string().describe('The task ID to resume') },
  async (args) => {
    const data = {
      type: 'resume_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} resume requested.` }] };
  },
);

server.tool(
  'cancel_task',
  'Cancel and delete a scheduled task.',
  { task_id: z.string().describe('The task ID to cancel') },
  async (args) => {
    const data = {
      type: 'cancel_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} cancellation requested.` }] };
  },
);

server.tool(
  'update_task',
  'Update an existing scheduled task. Only provided fields are changed; omitted fields stay the same.',
  {
    task_id: z.string().describe('The task ID to update'),
    prompt: z.string().optional().describe('New prompt for the task'),
    schedule_type: z.enum(['cron', 'interval', 'once']).optional().describe('New schedule type'),
    schedule_value: z.string().optional().describe('New schedule value (see schedule_task for format)'),
  },
  async (args) => {
    // Validate schedule_value if provided
    if (args.schedule_type === 'cron' || (!args.schedule_type && args.schedule_value)) {
      if (args.schedule_value) {
        try {
          CronExpressionParser.parse(args.schedule_value);
        } catch {
          return {
            content: [{ type: 'text' as const, text: `Invalid cron: "${args.schedule_value}".` }],
            isError: true,
          };
        }
      }
    }
    if (args.schedule_type === 'interval' && args.schedule_value) {
      const ms = parseInt(args.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        return {
          content: [{ type: 'text' as const, text: `Invalid interval: "${args.schedule_value}".` }],
          isError: true,
        };
      }
    }

    const data: Record<string, string | undefined> = {
      type: 'update_task',
      taskId: args.task_id,
      groupFolder,
      isMain: String(isMain),
      timestamp: new Date().toISOString(),
    };
    if (args.prompt !== undefined) data.prompt = args.prompt;
    if (args.schedule_type !== undefined) data.schedule_type = args.schedule_type;
    if (args.schedule_value !== undefined) data.schedule_value = args.schedule_value;

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} update requested.` }] };
  },
);

server.tool(
  'register_group',
  `Register a new chat/group so the agent can respond to messages there. Main group only.

Use available_groups.json to find the JID for a group. The folder name must be channel-prefixed: "{channel}_{group-name}" (e.g., "whatsapp_family-chat", "telegram_dev-team", "discord_general"). Use lowercase with hyphens for the group name part.`,
  {
    jid: z.string().describe('The chat JID (e.g., "120363336345536173@g.us", "tg:-1001234567890", "dc:1234567890123456")'),
    name: z.string().describe('Display name for the group'),
    folder: z.string().describe('Channel-prefixed folder name (e.g., "whatsapp_family-chat", "telegram_dev-team")'),
    trigger: z.string().describe('Trigger word (e.g., "@Andy")'),
  },
  async (args) => {
    if (!isMain) {
      return {
        content: [{ type: 'text' as const, text: 'Only the main group can register new groups.' }],
        isError: true,
      };
    }

    const data = {
      type: 'register_group',
      jid: args.jid,
      name: args.name,
      folder: args.folder,
      trigger: args.trigger,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `Group "${args.name}" registered. It will start receiving messages immediately.` }],
    };
  },
);

// --- X (Twitter) Integration Tools ---

const X_RESULTS_DIR = path.join(IPC_DIR, 'x_results');

async function waitForXResult(requestId: string, maxWait = 120000): Promise<{ success: boolean; message: string }> {
  const resultFile = path.join(X_RESULTS_DIR, `${requestId}.json`);
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

  return { success: false, message: 'Request timed out (120s)' };
}

server.tool(
  'x_post',
  `Post a tweet to X (Twitter). Main group only. The host machine will execute browser automation to post the tweet.`,
  {
    content: z.string().max(280).describe('The tweet content to post (max 280 characters)'),
  },
  async (args) => {
    if (!isMain) {
      return { content: [{ type: 'text' as const, text: 'Only the main group can post tweets.' }], isError: true };
    }
    const requestId = `xpost-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    writeIpcFile(TASKS_DIR, {
      type: 'x_post',
      requestId,
      content: args.content,
      groupFolder,
      timestamp: new Date().toISOString(),
    });
    const result = await waitForXResult(requestId);
    return { content: [{ type: 'text' as const, text: result.message }], isError: !result.success };
  },
);

server.tool(
  'x_like',
  `Like a tweet on X (Twitter). Main group only.`,
  {
    tweet_url: z.string().describe('The tweet URL (e.g., https://x.com/user/status/123)'),
  },
  async (args) => {
    if (!isMain) {
      return { content: [{ type: 'text' as const, text: 'Only the main group can interact with X.' }], isError: true };
    }
    const requestId = `xlike-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    writeIpcFile(TASKS_DIR, {
      type: 'x_like',
      requestId,
      tweetUrl: args.tweet_url,
      groupFolder,
      timestamp: new Date().toISOString(),
    });
    const result = await waitForXResult(requestId);
    return { content: [{ type: 'text' as const, text: result.message }], isError: !result.success };
  },
);

server.tool(
  'x_reply',
  `Reply to a tweet on X (Twitter). Main group only.`,
  {
    tweet_url: z.string().describe('The tweet URL (e.g., https://x.com/user/status/123)'),
    content: z.string().max(280).describe('The reply content (max 280 characters)'),
  },
  async (args) => {
    if (!isMain) {
      return { content: [{ type: 'text' as const, text: 'Only the main group can interact with X.' }], isError: true };
    }
    const requestId = `xreply-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    writeIpcFile(TASKS_DIR, {
      type: 'x_reply',
      requestId,
      tweetUrl: args.tweet_url,
      content: args.content,
      groupFolder,
      timestamp: new Date().toISOString(),
    });
    const result = await waitForXResult(requestId);
    return { content: [{ type: 'text' as const, text: result.message }], isError: !result.success };
  },
);

server.tool(
  'x_retweet',
  `Retweet a tweet on X (Twitter). Main group only.`,
  {
    tweet_url: z.string().describe('The tweet URL (e.g., https://x.com/user/status/123)'),
  },
  async (args) => {
    if (!isMain) {
      return { content: [{ type: 'text' as const, text: 'Only the main group can interact with X.' }], isError: true };
    }
    const requestId = `xretweet-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    writeIpcFile(TASKS_DIR, {
      type: 'x_retweet',
      requestId,
      tweetUrl: args.tweet_url,
      groupFolder,
      timestamp: new Date().toISOString(),
    });
    const result = await waitForXResult(requestId);
    return { content: [{ type: 'text' as const, text: result.message }], isError: !result.success };
  },
);

server.tool(
  'x_quote',
  `Quote tweet on X (Twitter) with your own comment. Main group only.`,
  {
    tweet_url: z.string().describe('The tweet URL (e.g., https://x.com/user/status/123)'),
    comment: z.string().max(280).describe('Your comment for the quote tweet (max 280 characters)'),
  },
  async (args) => {
    if (!isMain) {
      return { content: [{ type: 'text' as const, text: 'Only the main group can interact with X.' }], isError: true };
    }
    const requestId = `xquote-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    writeIpcFile(TASKS_DIR, {
      type: 'x_quote',
      requestId,
      tweetUrl: args.tweet_url,
      comment: args.comment,
      groupFolder,
      timestamp: new Date().toISOString(),
    });
    const result = await waitForXResult(requestId);
    return { content: [{ type: 'text' as const, text: result.message }], isError: !result.success };
  },
);

server.tool(
  'x_read_feed',
  `Read the home timeline/feed on X (Twitter). Main group only.

Returns recent tweets from the home feed with author, content, engagement metrics, and URLs.
Use this to see what's on the timeline, find tweets to interact with, or stay informed.
After reading the feed, you can like, reply, retweet, or quote any tweet using its URL.`,
  {
    count: z.number().min(1).max(25).optional().describe('Number of tweets to retrieve (default: 10, max: 25)'),
  },
  async (args) => {
    if (!isMain) {
      return { content: [{ type: 'text' as const, text: 'Only the main group can read the X feed.' }], isError: true };
    }
    const requestId = `xfeed-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    writeIpcFile(TASKS_DIR, {
      type: 'x_read_feed',
      requestId,
      count: args.count || 10,
      groupFolder,
      timestamp: new Date().toISOString(),
    });
    const result = await waitForXResult(requestId, 90000) as { success: boolean; message: string; data?: { tweets?: Array<{ author: string; handle: string; content: string; timestamp: string; url: string; likes: string; retweets: string; replies: string; views: string }>; count?: number } };
    if (!result.success) {
      return { content: [{ type: 'text' as const, text: result.message }], isError: true };
    }
    const data = result.data;
    let formatted = `Feed (${data?.count || 0} tweets):\n\n`;
    if (data?.tweets) {
      for (const tweet of data.tweets) {
        formatted += `${tweet.handle || '@unknown'} (${tweet.author || 'Unknown'})\n`;
        formatted += `${tweet.content}\n`;
        formatted += `♥ ${tweet.likes}  🔁 ${tweet.retweets}  💬 ${tweet.replies}  👁 ${tweet.views}\n`;
        if (tweet.url) formatted += `${tweet.url}\n`;
        if (tweet.timestamp) formatted += `${tweet.timestamp}\n`;
        formatted += '---\n';
      }
    }
    return { content: [{ type: 'text' as const, text: formatted }], isError: false };
  },
);

server.tool(
  'x_read_notifications',
  `Read notifications on X (Twitter). Main group only.

Returns recent notifications including likes, retweets, replies, mentions, follows, and quotes.
Optionally filter to only mentions. Use this to stay on top of engagement and respond to interactions.`,
  {
    count: z.number().min(1).max(25).optional().describe('Number of notifications to retrieve (default: 10, max: 25)'),
    filter: z.enum(['all', 'mentions']).optional().describe('Filter: "all" for all notifications, "mentions" for only mentions (default: "all")'),
  },
  async (args) => {
    if (!isMain) {
      return { content: [{ type: 'text' as const, text: 'Only the main group can read X notifications.' }], isError: true };
    }
    const requestId = `xnotif-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    writeIpcFile(TASKS_DIR, {
      type: 'x_read_notifications',
      requestId,
      count: args.count || 10,
      filter: args.filter || 'all',
      groupFolder,
      timestamp: new Date().toISOString(),
    });
    const result = await waitForXResult(requestId, 90000) as { success: boolean; message: string; data?: { notifications?: Array<{ type: string; actors: string; text: string; tweetUrl: string; timestamp: string }>; count?: number } };
    if (!result.success) {
      return { content: [{ type: 'text' as const, text: result.message }], isError: true };
    }
    const data = result.data;
    let formatted = `Notifications (${data?.count || 0}):\n\n`;
    if (data?.notifications) {
      for (const notif of data.notifications) {
        formatted += `[${notif.type.toUpperCase()}] ${notif.actors}\n`;
        formatted += `${notif.text}\n`;
        if (notif.tweetUrl) formatted += `${notif.tweetUrl}\n`;
        if (notif.timestamp) formatted += `${notif.timestamp}\n`;
        formatted += '---\n';
      }
    }
    return { content: [{ type: 'text' as const, text: formatted }], isError: false };
  },
);

server.tool(
  'x_dm',
  `Send a direct message to a user on X (Twitter). Main group only.

Send a private DM to any X user. Works best with Premium/verified accounts that can DM anyone.
A DM from a verified account with real engagement is far more credible than a cold reply.
Use this for personalized outreach to accounts like founders, creators, or potential collaborators.`,
  {
    username: z.string().describe('The X username to DM (e.g., "@levelsio" or "levelsio" or "https://x.com/levelsio")'),
    message: z.string().max(10000).describe('The DM message to send (max 10,000 characters)'),
  },
  async (args) => {
    if (!isMain) {
      return { content: [{ type: 'text' as const, text: 'Only the main group can send X DMs.' }], isError: true };
    }
    const requestId = `xdm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    writeIpcFile(TASKS_DIR, {
      type: 'x_dm',
      requestId,
      username: args.username,
      message: args.message,
      groupFolder,
      timestamp: new Date().toISOString(),
    });
    const result = await waitForXResult(requestId, 90000);
    return { content: [{ type: 'text' as const, text: result.message }], isError: !result.success };
  },
);

// --- New X Tools: get_tweet, search, read_thread, read_profile, get_analytics, follow ---

server.tool(
  'x_get_tweet',
  `Get full metadata for a specific tweet on X (Twitter). Main group only.

Returns author info (handle, display name, follower count), tweet content, engagement metrics
(views, likes, retweets, replies), reply policy, media type, and thread context.
Use this BEFORE replying to check if replies are restricted — prevents wasted attempts.`,
  {
    tweet_url: z.string().describe('The tweet URL (e.g., https://x.com/user/status/123)'),
  },
  async (args) => {
    if (!isMain) {
      return { content: [{ type: 'text' as const, text: 'Only the main group can access X.' }], isError: true };
    }
    const requestId = `xgettweet-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    writeIpcFile(TASKS_DIR, {
      type: 'x_get_tweet',
      requestId,
      tweetUrl: args.tweet_url,
      groupFolder,
      timestamp: new Date().toISOString(),
    });
    const result = await waitForXResult(requestId, 90000) as { success: boolean; message: string; data?: any };
    if (!result.success) {
      return { content: [{ type: 'text' as const, text: result.message }], isError: true };
    }
    const data = result.data;
    let formatted = `Tweet by @${data?.author?.handle || 'unknown'} (${data?.author?.displayName || 'Unknown'})\n`;
    if (data?.author?.followers) formatted += `Followers: ${data.author.followers}\n`;
    formatted += `\n${data?.content || ''}\n\n`;
    formatted += `♥ ${data?.metrics?.likes || 0}  🔁 ${data?.metrics?.retweets || 0}  💬 ${data?.metrics?.replies || 0}  👁 ${data?.metrics?.views || 0}\n`;
    if (data?.replyPolicy) formatted += `Reply policy: ${data.replyPolicy}\n`;
    if (data?.mediaType) formatted += `Media: ${data.mediaType}\n`;
    if (data?.isReply) formatted += `Is reply: yes\n`;
    if (data?.timestamp) formatted += `Posted: ${data.timestamp}\n`;
    return { content: [{ type: 'text' as const, text: formatted }], isError: false };
  },
);

server.tool(
  'x_search',
  `Search for tweets on X (Twitter). Main group only.

Search X for tweets matching a query. Defaults to "Latest" tab for recency — optimal for
finding engagement targets in the 2-4h window. Supports X search operators (from:, to:, #hashtag).
Eliminates dependency on Google/WebSearch which has 12-48h indexing delay.`,
  {
    query: z.string().describe('Search query (supports X operators like "from:user", "to:user", "#hashtag")'),
    count: z.number().min(1).max(25).optional().describe('Number of tweets to retrieve (default: 10, max: 25)'),
    sort: z.enum(['latest', 'top']).optional().describe('Sort order: "latest" for most recent, "top" for algorithmic ranking (default: "latest")'),
  },
  async (args) => {
    if (!isMain) {
      return { content: [{ type: 'text' as const, text: 'Only the main group can search X.' }], isError: true };
    }
    const requestId = `xsearch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    writeIpcFile(TASKS_DIR, {
      type: 'x_search',
      requestId,
      query: args.query,
      count: args.count || 10,
      sort: args.sort || 'latest',
      groupFolder,
      timestamp: new Date().toISOString(),
    });
    const result = await waitForXResult(requestId, 90000) as { success: boolean; message: string; data?: any };
    if (!result.success) {
      return { content: [{ type: 'text' as const, text: result.message }], isError: true };
    }
    const data = result.data;
    let formatted = `Search results for "${args.query}" (${data?.count || 0} tweets):\n\n`;
    if (data?.tweets) {
      for (const tweet of data.tweets) {
        formatted += `@${tweet.handle || 'unknown'} (${tweet.author || 'Unknown'})\n`;
        formatted += `${tweet.content}\n`;
        formatted += `♥ ${tweet.likes || 0}  🔁 ${tweet.retweets || 0}  💬 ${tweet.replies || 0}  👁 ${tweet.views || 0}\n`;
        if (tweet.url) formatted += `${tweet.url}\n`;
        if (tweet.timestamp) formatted += `${tweet.timestamp}\n`;
        formatted += '---\n';
      }
    }
    return { content: [{ type: 'text' as const, text: formatted }], isError: false };
  },
);

server.tool(
  'x_read_thread',
  `Read a full conversation thread on X (Twitter). Main group only.

Navigates to a tweet and extracts the full conversation context: parent tweets (what this tweet
is replying to), the focal tweet itself, and replies from other users. Use this BEFORE replying
to understand what others have already said in the thread — prevents redundant or tone-deaf replies.`,
  {
    tweet_url: z.string().describe('The tweet URL (e.g., https://x.com/user/status/123)'),
  },
  async (args) => {
    if (!isMain) {
      return { content: [{ type: 'text' as const, text: 'Only the main group can access X.' }], isError: true };
    }
    const requestId = `xthread-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    writeIpcFile(TASKS_DIR, {
      type: 'x_read_thread',
      requestId,
      tweetUrl: args.tweet_url,
      groupFolder,
      timestamp: new Date().toISOString(),
    });
    const result = await waitForXResult(requestId, 90000) as { success: boolean; message: string; data?: any };
    if (!result.success) {
      return { content: [{ type: 'text' as const, text: result.message }], isError: true };
    }
    const data = result.data;
    let formatted = '';
    if (data?.parentTweets?.length) {
      formatted += '── Parent tweets ──\n';
      for (const tweet of data.parentTweets) {
        formatted += `@${tweet.handle || 'unknown'}: ${tweet.content}\n`;
        if (tweet.url) formatted += `${tweet.url}\n`;
        formatted += '---\n';
      }
    }
    if (data?.focalTweet) {
      formatted += '\n── Focal tweet ──\n';
      const t = data.focalTweet;
      formatted += `@${t.handle || 'unknown'} (${t.author || 'Unknown'})\n`;
      formatted += `${t.content}\n`;
      formatted += `♥ ${t.likes || 0}  🔁 ${t.retweets || 0}  💬 ${t.replies || 0}  👁 ${t.views || 0}\n`;
      formatted += '---\n';
    }
    if (data?.replies?.length) {
      formatted += `\n── Replies (${data.replies.length}) ──\n`;
      for (const tweet of data.replies) {
        formatted += `@${tweet.handle || 'unknown'}: ${tweet.content}\n`;
        if (tweet.url) formatted += `${tweet.url}\n`;
        formatted += '---\n';
      }
    }
    return { content: [{ type: 'text' as const, text: formatted || 'No thread data found.' }], isError: false };
  },
);

server.tool(
  'x_read_profile',
  `Read a user's profile on X (Twitter). Main group only.

Returns bio, follower/following counts, verification status, and recent tweets.
Use for proactive priority account scanning — check what key accounts (Karpathy, emollick,
garrytan, etc.) have posted recently without waiting for the algorithm to surface them.`,
  {
    username: z.string().describe('The username to look up (without @)'),
    tweet_count: z.number().min(1).max(10).optional().describe('Number of recent tweets to include (default: 5, max: 10)'),
  },
  async (args) => {
    if (!isMain) {
      return { content: [{ type: 'text' as const, text: 'Only the main group can access X.' }], isError: true };
    }
    const requestId = `xprofile-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    writeIpcFile(TASKS_DIR, {
      type: 'x_read_profile',
      requestId,
      username: args.username,
      tweetCount: args.tweet_count || 5,
      groupFolder,
      timestamp: new Date().toISOString(),
    });
    const result = await waitForXResult(requestId, 90000) as { success: boolean; message: string; data?: any };
    if (!result.success) {
      return { content: [{ type: 'text' as const, text: result.message }], isError: true };
    }
    const data = result.data;
    let formatted = `Profile: @${data?.username || args.username}\n`;
    if (data?.displayName) formatted += `Name: ${data.displayName}\n`;
    if (data?.bio) formatted += `Bio: ${data.bio}\n`;
    if (data?.verified) formatted += `Verified: ✓\n`;
    formatted += `Followers: ${data?.followers || 0} | Following: ${data?.following || 0}\n`;
    if (data?.tweets) formatted += `Tweets: ${data.tweets}\n`;
    if (data?.joinDate) formatted += `Joined: ${data.joinDate}\n`;
    if (data?.recentTweets?.length) {
      formatted += `\n── Recent tweets (${data.recentTweets.length}) ──\n`;
      for (const tweet of data.recentTweets) {
        formatted += `${tweet.content}\n`;
        formatted += `♥ ${tweet.likes || 0}  🔁 ${tweet.retweets || 0}  💬 ${tweet.replies || 0}  👁 ${tweet.views || 0}\n`;
        if (tweet.url) formatted += `${tweet.url}\n`;
        if (tweet.timestamp) formatted += `${tweet.timestamp}\n`;
        formatted += '---\n';
      }
    }
    return { content: [{ type: 'text' as const, text: formatted }], isError: false };
  },
);

server.tool(
  'x_get_analytics',
  `Get analytics for one of your own tweets on X (Twitter). Main group only.

Returns impressions, engagements, detail expands, link clicks, profile visits, and engagement rate.
Only works for tweets posted by the authenticated account. Required for the self-improvement
loop — use this to measure which reply angles and content styles are working.`,
  {
    tweet_url: z.string().describe('The tweet URL to get analytics for (must be your own tweet)'),
  },
  async (args) => {
    if (!isMain) {
      return { content: [{ type: 'text' as const, text: 'Only the main group can access X analytics.' }], isError: true };
    }
    const requestId = `xanalytics-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    writeIpcFile(TASKS_DIR, {
      type: 'x_get_analytics',
      requestId,
      tweetUrl: args.tweet_url,
      groupFolder,
      timestamp: new Date().toISOString(),
    });
    const result = await waitForXResult(requestId, 90000) as { success: boolean; message: string; data?: any };
    if (!result.success) {
      return { content: [{ type: 'text' as const, text: result.message }], isError: true };
    }
    const data = result.data;
    let formatted = `Analytics for tweet:\n`;
    if (data?.impressions !== undefined) formatted += `Impressions: ${data.impressions}\n`;
    if (data?.engagements !== undefined) formatted += `Engagements: ${data.engagements}\n`;
    if (data?.detailExpands !== undefined) formatted += `Detail expands: ${data.detailExpands}\n`;
    if (data?.linkClicks !== undefined) formatted += `Link clicks: ${data.linkClicks}\n`;
    if (data?.profileVisits !== undefined) formatted += `Profile visits: ${data.profileVisits}\n`;
    if (data?.likes !== undefined) formatted += `Likes: ${data.likes}\n`;
    if (data?.retweets !== undefined) formatted += `Retweets: ${data.retweets}\n`;
    if (data?.replies !== undefined) formatted += `Replies: ${data.replies}\n`;
    if (data?.engagementRate) formatted += `Engagement rate: ${data.engagementRate}\n`;
    return { content: [{ type: 'text' as const, text: formatted }], isError: false };
  },
);

server.tool(
  'x_follow',
  `Follow a user on X (Twitter). Main group only.`,
  {
    username: z.string().describe('The username to follow (without @)'),
  },
  async (args) => {
    if (!isMain) {
      return { content: [{ type: 'text' as const, text: 'Only the main group can follow users.' }], isError: true };
    }
    const requestId = `xfollow-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    writeIpcFile(TASKS_DIR, {
      type: 'x_follow',
      requestId,
      username: args.username,
      groupFolder,
      timestamp: new Date().toISOString(),
    });
    const result = await waitForXResult(requestId);
    return { content: [{ type: 'text' as const, text: result.message }], isError: !result.success };
  },
);

// --- KP (Kanban Pro) Integration Tools ---

const KP_RESULTS_DIR = path.join(IPC_DIR, 'kp_results');

async function waitForKpResult(requestId: string, maxWait = 60000): Promise<{ success: boolean; message: string }> {
  const resultFile = path.join(KP_RESULTS_DIR, `${requestId}.json`);
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

server.tool(
  'kp_open_project',
  `Launch Kanban Pro and open a project folder. Main group only. Use this before any other kp_* tool if KP isn't already open.`,
  {
    project_path: z.string().describe('Absolute path to the KP project folder'),
  },
  async (args) => {
    if (!isMain) {
      return { content: [{ type: 'text' as const, text: 'Only the main group can control KP.' }], isError: true };
    }
    const requestId = `kp-openproj-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    writeIpcFile(TASKS_DIR, {
      type: 'kp_open_project',
      requestId,
      projectPath: args.project_path,
      groupFolder,
      timestamp: new Date().toISOString(),
    });
    const result = await waitForKpResult(requestId, 30000);
    return { content: [{ type: 'text' as const, text: result.message }], isError: !result.success };
  },
);

server.tool(
  'kp_create_ticket',
  `Create a new ticket in Kanban Pro. Main group only. Opens the KP app, navigates to the project, and creates a ticket in the specified column.`,
  {
    project_path: z.string().describe('Absolute path to the KP project folder'),
    title: z.string().describe('The ticket title'),
    column_index: z.number().min(0).optional().describe('Column index (0-based, default: 0 = first column)'),
  },
  async (args) => {
    if (!isMain) {
      return { content: [{ type: 'text' as const, text: 'Only the main group can control KP.' }], isError: true };
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
    const result = await waitForKpResult(requestId);
    return { content: [{ type: 'text' as const, text: result.message }], isError: !result.success };
  },
);

server.tool(
  'kp_move_ticket',
  `Move a ticket card to a different column in Kanban Pro. Main group only. Drags the card from its current column to the target column.`,
  {
    project_path: z.string().describe('Absolute path to the KP project folder'),
    ticket_title: z.string().describe('Title of the ticket to move'),
    target_column_index: z.number().min(0).describe('Target column index (0-based)'),
  },
  async (args) => {
    if (!isMain) {
      return { content: [{ type: 'text' as const, text: 'Only the main group can control KP.' }], isError: true };
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
    const result = await waitForKpResult(requestId);
    return { content: [{ type: 'text' as const, text: result.message }], isError: !result.success };
  },
);

server.tool(
  'kp_open_ticket',
  `Open a ticket's detail panel in Kanban Pro. Main group only.`,
  {
    project_path: z.string().describe('Absolute path to the KP project folder'),
    ticket_title: z.string().describe('Title of the ticket to open'),
  },
  async (args) => {
    if (!isMain) {
      return { content: [{ type: 'text' as const, text: 'Only the main group can control KP.' }], isError: true };
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
    const result = await waitForKpResult(requestId);
    return { content: [{ type: 'text' as const, text: result.message }], isError: !result.success };
  },
);

server.tool(
  'kp_update_field',
  `Edit a field on a ticket in Kanban Pro. Main group only. Supported fields: title, description, tags.`,
  {
    project_path: z.string().describe('Absolute path to the KP project folder'),
    ticket_title: z.string().describe('Title of the ticket to edit'),
    field: z.enum(['title', 'description', 'tags']).describe('Field to edit'),
    value: z.string().describe('New value for the field'),
  },
  async (args) => {
    if (!isMain) {
      return { content: [{ type: 'text' as const, text: 'Only the main group can control KP.' }], isError: true };
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
    const result = await waitForKpResult(requestId);
    return { content: [{ type: 'text' as const, text: result.message }], isError: !result.success };
  },
);

server.tool(
  'kp_switch_view',
  `Switch between views in Kanban Pro. Main group only. Available views: board, list, table, calendar, gantt.`,
  {
    project_path: z.string().describe('Absolute path to the KP project folder'),
    view: z.enum(['board', 'list', 'table', 'calendar', 'gantt']).describe('Target view'),
  },
  async (args) => {
    if (!isMain) {
      return { content: [{ type: 'text' as const, text: 'Only the main group can control KP.' }], isError: true };
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
    const result = await waitForKpResult(requestId);
    return { content: [{ type: 'text' as const, text: result.message }], isError: !result.success };
  },
);

server.tool(
  'kp_search',
  `Search for tickets in Kanban Pro using Cmd+K. Main group only.`,
  {
    project_path: z.string().describe('Absolute path to the KP project folder'),
    query: z.string().describe('Search query'),
    select_first: z.boolean().optional().describe('Click the first result (default: false)'),
  },
  async (args) => {
    if (!isMain) {
      return { content: [{ type: 'text' as const, text: 'Only the main group can control KP.' }], isError: true };
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
    const result = await waitForKpResult(requestId);
    return { content: [{ type: 'text' as const, text: result.message }], isError: !result.success };
  },
);

server.tool(
  'kp_add_comment',
  `Add a comment to a ticket in Kanban Pro. Main group only.`,
  {
    project_path: z.string().describe('Absolute path to the KP project folder'),
    ticket_title: z.string().describe('Title of the ticket'),
    comment: z.string().describe('Comment text to add'),
  },
  async (args) => {
    if (!isMain) {
      return { content: [{ type: 'text' as const, text: 'Only the main group can control KP.' }], isError: true };
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
    const result = await waitForKpResult(requestId);
    return { content: [{ type: 'text' as const, text: result.message }], isError: !result.success };
  },
);

// Start the stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
