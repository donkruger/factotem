/**
 * X Integration - MCP Tool Definitions (Agent/Container Side)
 *
 * These tools run inside the container and communicate with the host via IPC.
 * The host-side implementation is in host.ts.
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
const RESULTS_DIR = path.join(IPC_DIR, 'x_results');

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
 * Create X integration MCP tools
 */
export function createXTools(ctx: SkillToolsContext) {
  const { groupFolder, isMain } = ctx;

  return [
    tool(
      'x_post',
      `Post a tweet to X (Twitter). Main group only.

The host machine will execute the browser automation to post the tweet.
Make sure the content is appropriate and within X's character limit (280 chars for text).`,
      {
        content: z.string().max(280).describe('The tweet content to post (max 280 characters)')
      },
      async (args: { content: string }) => {
        if (!isMain) {
          return {
            content: [{ type: 'text', text: 'Only the main group can post tweets.' }],
            isError: true
          };
        }

        if (args.content.length > 280) {
          return {
            content: [{ type: 'text', text: `Tweet exceeds 280 character limit (current: ${args.content.length})` }],
            isError: true
          };
        }

        const requestId = `xpost-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        writeIpcFile(TASKS_DIR, {
          type: 'x_post',
          requestId,
          content: args.content,
          groupFolder,
          timestamp: new Date().toISOString()
        });

        const result = await waitForResult(requestId);
        return {
          content: [{ type: 'text', text: result.message }],
          isError: !result.success
        };
      }
    ),

    tool(
      'x_like',
      `Like a tweet on X (Twitter). Main group only.

Provide the tweet URL or tweet ID to like.`,
      {
        tweet_url: z.string().describe('The tweet URL (e.g., https://x.com/user/status/123) or tweet ID')
      },
      async (args: { tweet_url: string }) => {
        if (!isMain) {
          return {
            content: [{ type: 'text', text: 'Only the main group can interact with X.' }],
            isError: true
          };
        }

        const requestId = `xlike-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        writeIpcFile(TASKS_DIR, {
          type: 'x_like',
          requestId,
          tweetUrl: args.tweet_url,
          groupFolder,
          timestamp: new Date().toISOString()
        });

        const result = await waitForResult(requestId);
        return {
          content: [{ type: 'text', text: result.message }],
          isError: !result.success
        };
      }
    ),

    tool(
      'x_reply',
      `Reply to a tweet on X (Twitter). Main group only.

Provide the tweet URL and your reply content.`,
      {
        tweet_url: z.string().describe('The tweet URL (e.g., https://x.com/user/status/123) or tweet ID'),
        content: z.string().max(280).describe('The reply content (max 280 characters)')
      },
      async (args: { tweet_url: string; content: string }) => {
        if (!isMain) {
          return {
            content: [{ type: 'text', text: 'Only the main group can interact with X.' }],
            isError: true
          };
        }

        const requestId = `xreply-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        writeIpcFile(TASKS_DIR, {
          type: 'x_reply',
          requestId,
          tweetUrl: args.tweet_url,
          content: args.content,
          groupFolder,
          timestamp: new Date().toISOString()
        });

        const result = await waitForResult(requestId);
        return {
          content: [{ type: 'text', text: result.message }],
          isError: !result.success
        };
      }
    ),

    tool(
      'x_retweet',
      `Retweet a tweet on X (Twitter). Main group only.

Provide the tweet URL to retweet.`,
      {
        tweet_url: z.string().describe('The tweet URL (e.g., https://x.com/user/status/123) or tweet ID')
      },
      async (args: { tweet_url: string }) => {
        if (!isMain) {
          return {
            content: [{ type: 'text', text: 'Only the main group can interact with X.' }],
            isError: true
          };
        }

        const requestId = `xretweet-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        writeIpcFile(TASKS_DIR, {
          type: 'x_retweet',
          requestId,
          tweetUrl: args.tweet_url,
          groupFolder,
          timestamp: new Date().toISOString()
        });

        const result = await waitForResult(requestId);
        return {
          content: [{ type: 'text', text: result.message }],
          isError: !result.success
        };
      }
    ),

    tool(
      'x_quote',
      `Quote tweet on X (Twitter). Main group only.

Retweet with your own comment added.`,
      {
        tweet_url: z.string().describe('The tweet URL (e.g., https://x.com/user/status/123) or tweet ID'),
        comment: z.string().max(280).describe('Your comment for the quote tweet (max 280 characters)')
      },
      async (args: { tweet_url: string; comment: string }) => {
        if (!isMain) {
          return {
            content: [{ type: 'text', text: 'Only the main group can interact with X.' }],
            isError: true
          };
        }

        const requestId = `xquote-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        writeIpcFile(TASKS_DIR, {
          type: 'x_quote',
          requestId,
          tweetUrl: args.tweet_url,
          comment: args.comment,
          groupFolder,
          timestamp: new Date().toISOString()
        });

        const result = await waitForResult(requestId);
        return {
          content: [{ type: 'text', text: result.message }],
          isError: !result.success
        };
      }
    ),

    tool(
      'x_read_feed',
      `Read the home timeline/feed on X (Twitter). Main group only.

Returns recent tweets from the home feed with author, content, engagement metrics, and URLs.
Use this to see what's on the timeline, find tweets to interact with, or stay informed.`,
      {
        count: z.number().min(1).max(25).optional().describe('Number of tweets to retrieve (default: 10, max: 25)')
      },
      async (args: { count?: number }) => {
        if (!isMain) {
          return {
            content: [{ type: 'text', text: 'Only the main group can read the X feed.' }],
            isError: true
          };
        }

        const requestId = `xfeed-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        writeIpcFile(TASKS_DIR, {
          type: 'x_read_feed',
          requestId,
          count: args.count || 10,
          groupFolder,
          timestamp: new Date().toISOString()
        });

        const result = await waitForResult(requestId, 90000);
        if (!result.success) {
          return {
            content: [{ type: 'text', text: result.message }],
            isError: true
          };
        }

        // Format tweets for the agent
        const data = (result as any).data;
        let formatted = `Feed (${data?.count || 0} tweets):\n\n`;
        if (data?.tweets) {
          for (const tweet of data.tweets) {
            formatted += `@${tweet.handle || 'unknown'} (${tweet.author || 'Unknown'})\n`;
            formatted += `${tweet.content}\n`;
            formatted += `♥ ${tweet.likes}  🔁 ${tweet.retweets}  💬 ${tweet.replies}  👁 ${tweet.views}\n`;
            if (tweet.url) formatted += `${tweet.url}\n`;
            if (tweet.timestamp) formatted += `${tweet.timestamp}\n`;
            formatted += '---\n';
          }
        }

        return {
          content: [{ type: 'text', text: formatted }],
          isError: false
        };
      }
    ),

    tool(
      'x_read_notifications',
      `Read notifications on X (Twitter). Main group only.

Returns recent notifications including likes, retweets, replies, mentions, follows, and quotes.
Optionally filter to only mentions.`,
      {
        count: z.number().min(1).max(25).optional().describe('Number of notifications to retrieve (default: 10, max: 25)'),
        filter: z.enum(['all', 'mentions']).optional().describe('Filter: "all" for all notifications, "mentions" for only mentions (default: "all")')
      },
      async (args: { count?: number; filter?: 'all' | 'mentions' }) => {
        if (!isMain) {
          return {
            content: [{ type: 'text', text: 'Only the main group can read X notifications.' }],
            isError: true
          };
        }

        const requestId = `xnotif-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        writeIpcFile(TASKS_DIR, {
          type: 'x_read_notifications',
          requestId,
          count: args.count || 10,
          filter: args.filter || 'all',
          groupFolder,
          timestamp: new Date().toISOString()
        });

        const result = await waitForResult(requestId, 90000);
        if (!result.success) {
          return {
            content: [{ type: 'text', text: result.message }],
            isError: true
          };
        }

        // Format notifications for the agent
        const data = (result as any).data;
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

        return {
          content: [{ type: 'text', text: formatted }],
          isError: false
        };
      }
    ),

    tool(
      'x_dm',
      `Send a direct message on X (Twitter). Main group only.

Send a DM to a user by their username.`,
      {
        username: z.string().describe('The username to DM (without @)'),
        message: z.string().describe('The message to send')
      },
      async (args: { username: string; message: string }) => {
        if (!isMain) {
          return {
            content: [{ type: 'text', text: 'Only the main group can send DMs.' }],
            isError: true
          };
        }

        const requestId = `xdm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        writeIpcFile(TASKS_DIR, {
          type: 'x_dm',
          requestId,
          username: args.username,
          message: args.message,
          groupFolder,
          timestamp: new Date().toISOString()
        });

        const result = await waitForResult(requestId);
        return {
          content: [{ type: 'text', text: result.message }],
          isError: !result.success
        };
      }
    ),

    tool(
      'x_get_tweet',
      `Get full metadata for a specific tweet on X (Twitter). Main group only.

Returns author info, content, engagement metrics (views, likes, retweets, replies),
reply policy, media type, and whether the tweet is a reply or part of a thread.
Use this before replying to check if replies are restricted.`,
      {
        tweet_url: z.string().describe('The tweet URL (e.g., https://x.com/user/status/123)')
      },
      async (args: { tweet_url: string }) => {
        if (!isMain) {
          return {
            content: [{ type: 'text', text: 'Only the main group can access X.' }],
            isError: true
          };
        }

        const requestId = `xgettweet-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        writeIpcFile(TASKS_DIR, {
          type: 'x_get_tweet',
          requestId,
          tweetUrl: args.tweet_url,
          groupFolder,
          timestamp: new Date().toISOString()
        });

        const result = await waitForResult(requestId, 90000);
        if (!result.success) {
          return {
            content: [{ type: 'text', text: result.message }],
            isError: true
          };
        }

        const data = (result as any).data;
        let formatted = `Tweet by @${data?.author?.handle || 'unknown'} (${data?.author?.displayName || 'Unknown'})\n`;
        if (data?.author?.followers) formatted += `Followers: ${data.author.followers}\n`;
        formatted += `\n${data?.content || ''}\n\n`;
        formatted += `♥ ${data?.metrics?.likes || 0}  🔁 ${data?.metrics?.retweets || 0}  💬 ${data?.metrics?.replies || 0}  👁 ${data?.metrics?.views || 0}\n`;
        if (data?.replyPolicy) formatted += `Reply policy: ${data.replyPolicy}\n`;
        if (data?.mediaType) formatted += `Media: ${data.mediaType}\n`;
        if (data?.isReply) formatted += `Is reply: yes\n`;
        if (data?.timestamp) formatted += `Posted: ${data.timestamp}\n`;

        return {
          content: [{ type: 'text', text: formatted }],
          isError: false
        };
      }
    ),

    tool(
      'x_search',
      `Search for tweets on X (Twitter). Main group only.

Search for tweets matching a query. Defaults to "Latest" tab for recency
(optimal for finding tweets in the 2-4h engagement window).
Also supports "Top" for algorithmic ranking.`,
      {
        query: z.string().describe('Search query (supports X search operators like "from:", "to:", "#hashtag")'),
        count: z.number().min(1).max(25).optional().describe('Number of tweets to retrieve (default: 10, max: 25)'),
        sort: z.enum(['latest', 'top']).optional().describe('Sort order: "latest" for most recent, "top" for algorithmic ranking (default: "latest")')
      },
      async (args: { query: string; count?: number; sort?: 'latest' | 'top' }) => {
        if (!isMain) {
          return {
            content: [{ type: 'text', text: 'Only the main group can search X.' }],
            isError: true
          };
        }

        const requestId = `xsearch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        writeIpcFile(TASKS_DIR, {
          type: 'x_search',
          requestId,
          query: args.query,
          count: args.count || 10,
          sort: args.sort || 'latest',
          groupFolder,
          timestamp: new Date().toISOString()
        });

        const result = await waitForResult(requestId, 90000);
        if (!result.success) {
          return {
            content: [{ type: 'text', text: result.message }],
            isError: true
          };
        }

        const data = (result as any).data;
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

        return {
          content: [{ type: 'text', text: formatted }],
          isError: false
        };
      }
    ),

    tool(
      'x_read_thread',
      `Read a full conversation thread on X (Twitter). Main group only.

Navigates to a tweet and extracts the full conversation context:
parent tweets (what this tweet is replying to), the focal tweet, and replies.
Use this before replying to understand what others have already said.`,
      {
        tweet_url: z.string().describe('The tweet URL (e.g., https://x.com/user/status/123)')
      },
      async (args: { tweet_url: string }) => {
        if (!isMain) {
          return {
            content: [{ type: 'text', text: 'Only the main group can access X.' }],
            isError: true
          };
        }

        const requestId = `xthread-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        writeIpcFile(TASKS_DIR, {
          type: 'x_read_thread',
          requestId,
          tweetUrl: args.tweet_url,
          groupFolder,
          timestamp: new Date().toISOString()
        });

        const result = await waitForResult(requestId, 90000);
        if (!result.success) {
          return {
            content: [{ type: 'text', text: result.message }],
            isError: true
          };
        }

        const data = (result as any).data;
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

        return {
          content: [{ type: 'text', text: formatted || 'No thread data found.' }],
          isError: false
        };
      }
    ),

    tool(
      'x_read_profile',
      `Read a user's profile on X (Twitter). Main group only.

Returns bio, follower/following counts, verification status, and recent tweets.
Use for proactive priority account scanning (e.g., checking what Karpathy, emollick, garrytan
have posted recently) without waiting for the algorithm to surface them.`,
      {
        username: z.string().describe('The username to look up (without @)'),
        tweet_count: z.number().min(1).max(10).optional().describe('Number of recent tweets to include (default: 5, max: 10)')
      },
      async (args: { username: string; tweet_count?: number }) => {
        if (!isMain) {
          return {
            content: [{ type: 'text', text: 'Only the main group can access X.' }],
            isError: true
          };
        }

        const requestId = `xprofile-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        writeIpcFile(TASKS_DIR, {
          type: 'x_read_profile',
          requestId,
          username: args.username,
          tweetCount: args.tweet_count || 5,
          groupFolder,
          timestamp: new Date().toISOString()
        });

        const result = await waitForResult(requestId, 90000);
        if (!result.success) {
          return {
            content: [{ type: 'text', text: result.message }],
            isError: true
          };
        }

        const data = (result as any).data;
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

        return {
          content: [{ type: 'text', text: formatted }],
          isError: false
        };
      }
    ),

    tool(
      'x_get_analytics',
      `Get analytics for one of your own tweets on X (Twitter). Main group only.

Returns impressions, engagements, detail expands, link clicks, profile visits, and
engagement rate. Only works for tweets posted by the authenticated account.
Use this for the self-improvement loop — measure which reply angles are working.`,
      {
        tweet_url: z.string().describe('The tweet URL to get analytics for (must be your own tweet)')
      },
      async (args: { tweet_url: string }) => {
        if (!isMain) {
          return {
            content: [{ type: 'text', text: 'Only the main group can access X analytics.' }],
            isError: true
          };
        }

        const requestId = `xanalytics-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        writeIpcFile(TASKS_DIR, {
          type: 'x_get_analytics',
          requestId,
          tweetUrl: args.tweet_url,
          groupFolder,
          timestamp: new Date().toISOString()
        });

        const result = await waitForResult(requestId, 90000);
        if (!result.success) {
          return {
            content: [{ type: 'text', text: result.message }],
            isError: true
          };
        }

        const data = (result as any).data;
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

        return {
          content: [{ type: 'text', text: formatted }],
          isError: false
        };
      }
    ),

    tool(
      'x_follow',
      `Follow a user on X (Twitter). Main group only.

Follow a user by their username.`,
      {
        username: z.string().describe('The username to follow (without @)')
      },
      async (args: { username: string }) => {
        if (!isMain) {
          return {
            content: [{ type: 'text', text: 'Only the main group can follow users.' }],
            isError: true
          };
        }

        const requestId = `xfollow-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        writeIpcFile(TASKS_DIR, {
          type: 'x_follow',
          requestId,
          username: args.username,
          groupFolder,
          timestamp: new Date().toISOString()
        });

        const result = await waitForResult(requestId);
        return {
          content: [{ type: 'text', text: result.message }],
          isError: !result.success
        };
      }
    )
  ];
}
