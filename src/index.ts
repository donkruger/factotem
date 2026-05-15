import fs from 'fs';
import path from 'path';

import { OneCLI } from '@onecli-sh/sdk';

import {
  ASSISTANT_NAME,
  DATA_DIR,
  DEFAULT_TRIGGER,
  getTriggerPattern,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  MAX_MESSAGES_PER_PROMPT,
  ONECLI_URL,
  POLL_INTERVAL,
  TIMEZONE,
} from './config.js';
import './channels/index.js';
import {
  getChannelFactory,
  getRegisteredChannelNames,
  normaliseFactoryResult,
} from './channels/registry.js';
import {
  ContainerOutput,
  runContainerAgent,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import { getAgentOrDefault, resolveAgentByTrigger } from './agents.js';
import {
  cleanupOrphans,
  ensureContainerRuntimeRunning,
} from './container-runtime.js';
import { costCentsFromContainer } from './cost.js';
import {
  getAgentSpendForDate,
  getAllChats,
  getAllRegisteredGroups,
  getAllSessions,
  getAllTasks,
  getLastBotMessageTimestamp,
  getMessagesSince,
  getNewMessages,
  getRouterState,
  incrementAgentSpend,
  initDatabase,
  insertAgentTurn,
  setRegisteredGroup,
  setRouterState,
  setSession,
  storeChatMetadata,
  storeMessage,
} from './db.js';
import { getMachineIdentity } from './http/machine-identity.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { startHttpServer } from './http/server.js';
import { startIpcWatcher } from './ipc.js';
import { findChannel, formatMessages, formatOutbound } from './router.js';
import {
  restoreRemoteControl,
  startRemoteControl,
  stopRemoteControl,
} from './remote-control.js';
import { consume as openConsumeRateLimit } from './open-rate-limit.js';
import {
  evaluateOpenMode,
  isOverBudget as openIsOverBudget,
  loadOpenMode,
  recordSpawnSpend as openRecordSpawnSpend,
} from './open-mode.js';
import {
  isSenderAllowed,
  isTriggerAllowed,
  loadSenderAllowlist,
  shouldDropMessage,
} from './sender-allowlist.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { Channel, NewMessage, RegisteredGroup } from './types.js';
import { parseImageReferences } from './image.js';
import { logger } from './logger.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

let lastTimestamp = '';
let sessions: Record<string, string> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};
let messageLoopRunning = false;

const channels: Channel[] = [];
const queue = new GroupQueue();

const onecli = new OneCLI({ url: ONECLI_URL });

/**
 * Agent-reasoning leakage guardrail.
 *
 * The agent is instructed (groups/global/CLAUDE.md) to wrap internal
 * deliberation in <internal>…</internal> tags, and we strip those before
 * sending. But when the agent emits the same kind of deliberation without the
 * tags — e.g. "No response needed — already replied…" or "Already responded to
 * this screenshot when Don shared it…" — it would otherwise land in the
 * WhatsApp channel verbatim. These anchored patterns suppress the most common
 * shapes before the send. Keep them narrow: match only utterances a real reply
 * would never start with.
 */
const INTERNAL_REASONING_LEAK_PATTERNS: RegExp[] = [
  /^No response needed\b/i,
  /^Already responded\b/i,
  /^Side conversation\b/i,
  /^<internal\b/i,
  /^\[internal\b/i,
  /^\(No response\b/i,
  /^Staying quiet\b/i,
];

function looksLikeInternalReasoningLeak(text: string): boolean {
  return INTERNAL_REASONING_LEAK_PATTERNS.some((re) => re.test(text));
}

// WhatsApp's 'composing' presence auto-expires after ~25–30s if not refreshed.
// Ping well inside that window so the typing dot stays visible for the full
// duration of an agent turn. 20s gives ~5–10s of margin against clock skew
// and network jitter.
const TYPING_REFRESH_MS = 20_000;

/**
 * Start a self-refreshing typing indicator for a chat.
 *
 * Returns a stop function that clears the refresh timer and sends a single
 * 'paused' presence. Safe to call the stop function more than once.
 */
function startTypingRefresh(
  channel: Channel,
  chatJid: string,
): () => Promise<void> {
  const ping = (): void => {
    channel
      .setTyping?.(chatJid, true)
      ?.catch((err) => logger.debug({ chatJid, err }, 'Typing refresh failed'));
  };
  ping();
  const timer = setInterval(ping, TYPING_REFRESH_MS);
  let stopped = false;
  return async () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    try {
      await channel.setTyping?.(chatJid, false);
    } catch {
      // Ignore — WhatsApp socket may be mid-reconnect. The 'composing'
      // presence will expire on its own within ~30s.
    }
  };
}

// Per-jid typing controllers so the main turn path and the IPC pipe-in path
// can coordinate. Streaming containers outlive a single turn, so we can no
// longer scope typing to runAgent's promise (would keep the bubble up for the
// full IDLE_TIMEOUT after the last reply — see ben-log 2026-04-23).
const activeTyping = new Map<string, () => Promise<void>>();

function ensureTypingActive(channel: Channel, chatJid: string): void {
  if (activeTyping.has(chatJid)) return;
  activeTyping.set(chatJid, startTypingRefresh(channel, chatJid));
}

async function stopTypingFor(chatJid: string): Promise<void> {
  const stop = activeTyping.get(chatJid);
  if (!stop) return;
  activeTyping.delete(chatJid);
  await stop();
}

function newTurnId(): string {
  return Math.random().toString(36).slice(2, 10);
}

function ensureOneCLIAgent(jid: string, group: RegisteredGroup): void {
  if (group.isMain) return;
  const identifier = group.folder.toLowerCase().replace(/_/g, '-');
  onecli.ensureAgent({ name: group.name, identifier }).then(
    (res) => {
      logger.info(
        { jid, identifier, created: res.created },
        'OneCLI agent ensured',
      );
    },
    (err) => {
      logger.debug(
        { jid, identifier, err: String(err) },
        'OneCLI agent ensure skipped',
      );
    },
  );
}

function loadState(): void {
  lastTimestamp = getRouterState('last_timestamp') || '';
  const agentTs = getRouterState('last_agent_timestamp');
  try {
    lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
  } catch {
    logger.warn('Corrupted last_agent_timestamp in DB, resetting');
    lastAgentTimestamp = {};
  }
  sessions = getAllSessions();
  registeredGroups = getAllRegisteredGroups();
  logger.info(
    { groupCount: Object.keys(registeredGroups).length },
    'State loaded',
  );
}

/**
 * Return the message cursor for a group, recovering from the last bot reply
 * if lastAgentTimestamp is missing (new group, corrupted state, restart).
 */
function getOrRecoverCursor(chatJid: string): string {
  const existing = lastAgentTimestamp[chatJid];
  if (existing) return existing;

  const botTs = getLastBotMessageTimestamp(chatJid, ASSISTANT_NAME);
  if (botTs) {
    logger.info(
      { chatJid, recoveredFrom: botTs },
      'Recovered message cursor from last bot reply',
    );
    lastAgentTimestamp[chatJid] = botTs;
    saveState();
    return botTs;
  }
  return '';
}

function saveState(): void {
  setRouterState('last_timestamp', lastTimestamp);
  setRouterState('last_agent_timestamp', JSON.stringify(lastAgentTimestamp));
}

function registerGroup(jid: string, group: RegisteredGroup): void {
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(group.folder);
  } catch (err) {
    logger.warn(
      { jid, folder: group.folder, err },
      'Rejecting group registration with invalid folder',
    );
    return;
  }

  registeredGroups[jid] = group;
  setRegisteredGroup(jid, group);

  // Create group folder
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  // Copy CLAUDE.md template into the new group folder so agents have
  // identity and instructions from the first run.  (Fixes #1391)
  // Skipped for open_dm profile: stranger sessions must not inherit the
  // operator's curated global memory. They start with no per-group prompt
  // and run only with the SDK preset until an open-template is added.
  const isOpenDm = group.containerConfig?.agentProfile === 'open_dm';
  const groupMdFile = path.join(groupDir, 'CLAUDE.md');
  if (!isOpenDm && !fs.existsSync(groupMdFile)) {
    const templateFile = path.join(
      GROUPS_DIR,
      group.isMain ? 'main' : 'global',
      'CLAUDE.md',
    );
    if (fs.existsSync(templateFile)) {
      let content = fs.readFileSync(templateFile, 'utf-8');
      if (ASSISTANT_NAME !== 'Andy') {
        content = content.replace(/^# Andy$/m, `# ${ASSISTANT_NAME}`);
        content = content.replace(/You are Andy/g, `You are ${ASSISTANT_NAME}`);
      }
      fs.writeFileSync(groupMdFile, content);
      logger.info({ folder: group.folder }, 'Created CLAUDE.md from template');
    }
  }

  // Ensure a corresponding OneCLI agent exists (best-effort, non-blocking)
  ensureOneCLIAgent(jid, group);

  logger.info(
    { jid, name: group.name, folder: group.folder },
    'Group registered',
  );
}

/**
 * Get available groups list for the agent.
 * Returns groups ordered by most recent activity.
 */
export function getAvailableGroups(): import('./container-runner.js').AvailableGroup[] {
  const chats = getAllChats();
  const registeredJids = new Set(Object.keys(registeredGroups));

  return chats
    .filter(
      (c) =>
        c.jid !== '__group_sync__' && (c.is_group || registeredJids.has(c.jid)),
    )
    .map((c) => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid),
    }));
}

/** @internal - exported for testing */
export function _setRegisteredGroups(
  groups: Record<string, RegisteredGroup>,
): void {
  registeredGroups = groups;
}

/**
 * Process all pending messages for a group.
 * Called by the GroupQueue when it's this group's turn.
 */
async function processGroupMessages(chatJid: string): Promise<boolean> {
  const group = registeredGroups[chatJid];
  if (!group) return true;

  const channel = findChannel(channels, chatJid);
  if (!channel) {
    logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
    return true;
  }

  const isMainGroup = group.isMain === true;

  const missedMessages = getMessagesSince(
    chatJid,
    getOrRecoverCursor(chatJid),
    ASSISTANT_NAME,
    MAX_MESSAGES_PER_PROMPT,
  );

  if (missedMessages.length === 0) return true;

  // For non-main groups, check if trigger is required and present.
  //
  // Phase H.3 (Gemini blueprint PR 4): per-message trigger override.
  // Beyond the group's own trigger, scan every message for an
  // `@<agent>` prefix that matches *any* registered agent. When a
  // non-group-default agent's trigger matches, we dispatch to that
  // agent's container regardless of the group's assignment — operators
  // can say "@Ben what time is it" in Andy's group and get a Ben
  // response. Returns null when no agent override applies and we fall
  // back to the group's assigned agent.
  let agentOverride: ReturnType<typeof resolveAgentByTrigger> = null;
  if (!isMainGroup && group.requiresTrigger !== false) {
    const triggerPattern = getTriggerPattern(group.trigger);
    const allowlistCfg = loadSenderAllowlist();

    // Walk messages: keep the *last* message whose trigger matches
    // (either the group's own trigger or any agent trigger). That's
    // what the operator most recently asked for, so it wins.
    let hasTrigger = false;
    for (const m of missedMessages) {
      const allowed =
        m.is_from_me || isTriggerAllowed(chatJid, m.sender, allowlistCfg);
      if (!allowed) continue;
      const text = m.content.trim();
      // Per-agent trigger (multi-agent dispatch) — wins over the
      // group-default trigger when it matches.
      const byAgent = resolveAgentByTrigger(text);
      if (byAgent) {
        hasTrigger = true;
        agentOverride = byAgent;
        continue;
      }
      // Group-default trigger — keeps the legacy single-agent path
      // working unchanged for v1.0 installs.
      if (triggerPattern.test(text)) {
        hasTrigger = true;
        // Reset any earlier per-agent override — the most recent
        // group-trigger match means the operator wants the *group's*
        // assigned agent for this turn.
        agentOverride = null;
      }
    }
    if (!hasTrigger) return true;
  } else {
    // Main group / requiresTrigger=false path. Still let an explicit
    // `@<agent>` mention override the default agent, since the main
    // group is multi-agent-friendly territory by definition.
    for (const m of missedMessages) {
      const byAgent = resolveAgentByTrigger(m.content.trim());
      if (byAgent) {
        agentOverride = byAgent;
      }
    }
  }

  // If a per-message agent trigger fired, dispatch to that agent's
  // container even when the group is assigned elsewhere. We clone the
  // group object so the override doesn't leak into in-memory caches.
  const dispatchGroup =
    agentOverride && agentOverride.id !== (group.agent_id ?? null)
      ? { ...group, agent_id: agentOverride.id }
      : group;
  if (agentOverride && dispatchGroup !== group) {
    logger.info(
      {
        chatJid,
        groupAgent: group.agent_id ?? null,
        triggeredAgent: agentOverride.id,
      },
      'Per-message agent trigger overrode the group\'s assigned agent',
    );
  }

  const prompt = formatMessages(missedMessages, TIMEZONE, {
    name: group.name,
    chatJid,
    isMain: isMainGroup,
  });
  const imageAttachments = parseImageReferences(missedMessages);

  // Advance cursor so the piping path in startMessageLoop won't re-fetch
  // these messages. Save the old cursor so we can roll back on error.
  const previousCursor = lastAgentTimestamp[chatJid] || '';
  lastAgentTimestamp[chatJid] =
    missedMessages[missedMessages.length - 1].timestamp;
  saveState();

  const turnId = newTurnId();
  const turnStartMs = Date.now();
  const lastMsgTsMs = Date.parse(
    missedMessages[missedMessages.length - 1].timestamp,
  );
  logger.info(
    {
      turnId,
      chatJid,
      phase: 'msg.picked_up',
      ms: Number.isFinite(lastMsgTsMs) ? turnStartMs - lastMsgTsMs : null,
      messageCount: missedMessages.length,
    },
    'Latency: messages picked up from DB',
  );

  logger.info(
    { group: group.name, messageCount: missedMessages.length, turnId },
    'Processing messages',
  );

  // Track idle timer for closing stdin when agent is idle
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug(
        { group: group.name },
        'Idle timeout, closing container stdin',
      );
      queue.closeStdin(chatJid);
    }, IDLE_TIMEOUT);
  };

  // Typing indicator is scoped to per-turn activity, not container lifetime.
  // Started here, cleared on each result.status === 'success' (end of turn),
  // and re-armed on IPC pipe-in from startMessageLoop. Outer finally is a
  // safety net for errors / container exit.
  ensureTypingActive(channel, chatJid);
  let hadError = false;
  let outputSentToUser = false;

  let output: 'success' | 'error';
  try {
    output = await runAgent(
      dispatchGroup,
      prompt,
      chatJid,
      imageAttachments,
      turnId,
      async (result) => {
        // Streaming output callback — called for each agent result
        if (result.result) {
          const raw =
            typeof result.result === 'string'
              ? result.result
              : JSON.stringify(result.result);
          // Strip <internal>...</internal> blocks — agent uses these for internal reasoning
          const text = raw
            .replace(/<internal>[\s\S]*?<\/internal>/g, '')
            .trim();
          logger.info(
            { group: group.name, turnId },
            `Agent output: ${raw.length} chars`,
          );
          if (text) {
            if (looksLikeInternalReasoningLeak(text)) {
              logger.warn(
                { group: group.name, preview: text.slice(0, 160), turnId },
                'Suppressed agent-reasoning leak (looked like internal deliberation sent without <internal> tags)',
              );
            } else {
              await channel.sendMessage(chatJid, text, { model: result.model });
              outputSentToUser = true;
            }
          }
          // Only reset idle timer on actual results, not session-update markers (result: null)
          resetIdleTimer();
        }

        if (result.status === 'success') {
          await stopTypingFor(chatJid);
          queue.notifyIdle(chatJid);
        }

        if (result.status === 'error') {
          hadError = true;
        }
      },
    );
  } finally {
    await stopTypingFor(chatJid);
    if (idleTimer) clearTimeout(idleTimer);
  }

  logger.info(
    {
      turnId,
      chatJid,
      phase: 'turn.completed',
      ms: Date.now() - turnStartMs,
      status: hadError || output === 'error' ? 'error' : 'success',
      outputSentToUser,
    },
    'Latency: turn completed',
  );

  if (output === 'error' || hadError) {
    // If we already sent output to the user, don't roll back the cursor —
    // the user got their response and re-processing would send duplicates.
    if (outputSentToUser) {
      logger.warn(
        { group: group.name },
        'Agent error after output was sent, skipping cursor rollback to prevent duplicates',
      );
      return true;
    }
    // Roll back cursor so retries can re-process these messages
    lastAgentTimestamp[chatJid] = previousCursor;
    saveState();
    logger.warn(
      { group: group.name },
      'Agent error, rolled back message cursor for retry',
    );
    return false;
  }

  return true;
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  imageAttachments: Array<{ relativePath: string; mediaType: string }>,
  turnId: string,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<'success' | 'error'> {
  const isMain = group.isMain === true;
  const sessionId = sessions[group.folder];

  // Update tasks snapshot for container to read (filtered by group)
  const tasks = getAllTasks();
  writeTasksSnapshot(
    group.folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      script: t.script || undefined,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  // Update available groups snapshot (main group only can see all groups)
  const availableGroups = getAvailableGroups();
  writeGroupsSnapshot(
    group.folder,
    isMain,
    availableGroups,
    new Set(Object.keys(registeredGroups)),
  );

  // Wrap onOutput to track session ID from streamed results AND write a
  // row to agent_turns (T-1778234000000) for every result the SDK emits.
  // Telemetry capture is best-effort: missing fields default to null/0
  // rather than block the message-send round-trip.
  const wrappedOnOutput = onOutput
    ? async (output: ContainerOutput) => {
        if (output.newSessionId) {
          sessions[group.folder] = output.newSessionId;
          setSession(group.folder, output.newSessionId);
        }
        // Telemetry write — only when the agent-runner emitted a result
        // (status === 'success' with usage data). For now we accept that
        // older cached agent-runner-src may not emit usage; those rows
        // simply won't get written.
        if (
          output.status === 'success' &&
          output.started_at &&
          output.finished_at
        ) {
          try {
            const machine = getMachineIdentity();
            const inputTokens = output.usage?.input_tokens ?? 0;
            const outputTokens = output.usage?.output_tokens ?? 0;
            const cacheCreate = output.usage?.cache_creation_input_tokens ?? 0;
            const cacheRead = output.usage?.cache_read_input_tokens ?? 0;
            const model = output.model ?? 'unknown';
            // Prefer the container's `cost_micros` when present
            // (authoritative — the container reads provider rates at
            // build time). Falls back to the token-derived estimate
            // for legacy containers (Claude image) that don't emit it.
            // See multi-agent-completion-blueprint § 3.1.
            const estCostCents = costCentsFromContainer(output, model);
            insertAgentTurn({
              turn_id: `${turnId}-${Date.now()}`,
              machine_id: machine.id,
              group_folder: group.folder,
              group_jid: chatJid,
              agent_profile: agentProfile ?? null,
              model,
              input_tokens: inputTokens,
              output_tokens: outputTokens,
              cache_creation_input_tokens: cacheCreate,
              cache_read_input_tokens: cacheRead,
              est_cost_cents: estCostCents,
              started_at: output.started_at,
              finished_at: output.finished_at,
              duration_ms: output.duration_ms ?? 0,
              duration_api_ms: output.duration_api_ms ?? null,
              ttft_ms: output.ttft_ms ?? null,
              tool_use_count: output.tool_use_count ?? 0,
              tool_error_count: output.tool_error_count ?? 0,
              retry_count: output.retry_count ?? 0,
              compaction_count: output.compaction_count ?? 0,
              num_turns: output.num_turns ?? null,
              outcome: 'success',
              prompt_chars: prompt.length,
              response_chars:
                output.response_chars ?? output.result?.length ?? 0,
              session_id: output.newSessionId ?? null,
              is_main: isMain ? 1 : 0,
              is_scheduled_task: 0,
              attachment_count: imageAttachments.length,
              // group here is the dispatchGroup — already carries the
              // trigger-override agent_id when @<trigger> dispatch
              // re-routed away from the group's assigned agent.
              // PR 8 § 3.2 of the multi-agent-completion blueprint.
              responder_agent_id: group.agent_id ?? null,
              // PR 12 § 3 — concurrency telemetry. queue.consumeQueueWait
              // is read-and-clear; subsequent reads for the same batch
              // return 0. concurrent_at_spawn is sampled at this
              // moment via the queue's public getter.
              queue_wait_ms: queue.consumeQueueWait(chatJid),
              concurrent_at_spawn: queue.getActiveCount(),
            });

            // PR 10 — per-agent spend rollup. Atomic INCR by today's
            // date + the responding agent. Used by the pre-spawn gate
            // to enforce daily_budget_cents on the next inbound.
            // Skipped silently when responder_agent_id is null
            // (pre-v1.2.1 turn) — the next gate firing has nothing
            // to enforce.
            if (group.agent_id && estCostCents > 0) {
              try {
                const today = new Date().toISOString().slice(0, 10);
                incrementAgentSpend(today, group.agent_id, estCostCents);
              } catch (err) {
                logger.debug(
                  { err, agentId: group.agent_id },
                  'agent_spend_log: increment failed (non-fatal)',
                );
              }
            }
          } catch (err) {
            logger.warn(
              { err, group: group.folder, turnId },
              'agent_turns: failed to insert telemetry row (non-fatal)',
            );
          }
        }
        await onOutput(output);
      }
    : undefined;

  // Open DM cost cap: enforce daily budget BEFORE spawn for open_dm groups.
  // Drop silently when exceeded — no canned reply (revealing the cap to a
  // flooder gives feedback, and an outbound costs additional money).
  const agentProfile = group.containerConfig?.agentProfile;
  if (agentProfile === 'open_dm') {
    const openMode = loadOpenMode(registeredGroups);
    if (!openMode || openIsOverBudget(openMode)) {
      logger.warn(
        { group: group.name, chatJid },
        'open-mode: daily budget exceeded — dropping spawn silently',
      );
      return 'success';
    }
    openRecordSpawnSpend(openMode);
  }

  // PR 10 — per-agent daily budget cap (multi-agent-completion § 4.2).
  // Independent of the group-level open-DM cap above; both layers
  // apply. The agent gate covers every group the agent answers
  // (regular groups, open-DM, scheduled tasks). Cap = NULL means
  // unbounded (v1.0 / v1.2 default).
  //
  // `group` here is the dispatchGroup — already carries the
  // trigger-override agent_id when @<trigger> dispatched away from
  // the group's assigned agent. The cap that fires is therefore
  // the *responding* agent's cap, not the group's owner's.
  if (group.agent_id) {
    const respondingAgent = getAgentOrDefault(group.agent_id);
    const cap = respondingAgent.daily_budget_cents;
    if (cap != null && cap > 0) {
      const today = new Date().toISOString().slice(0, 10);
      const spent = getAgentSpendForDate(today, respondingAgent.id);
      if (spent >= cap) {
        logger.warn(
          {
            agent: respondingAgent.id,
            spentCents: spent,
            capCents: cap,
            chatJid,
          },
          'agent budget hit — skipping spawn',
        );
        return 'success';
      }
    }
  }

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt,
        sessionId,
        groupFolder: group.folder,
        chatJid,
        isMain,
        assistantName: ASSISTANT_NAME,
        groupName: group.name,
        turnId,
        agentProfile,
        // Per-group model override (Phase 0 of T-1777809840000). When unset,
        // agent-runner falls back to ANTHROPIC_MODEL env var, then to Sonnet.
        model: group.containerConfig?.model,
        ...(imageAttachments.length > 0 && { imageAttachments }),
      },
      (proc, containerName) =>
        queue.registerProcess(chatJid, proc, containerName, group.folder),
      wrappedOnOutput,
    );

    if (output.newSessionId) {
      sessions[group.folder] = output.newSessionId;
      setSession(group.folder, output.newSessionId);
    }

    if (output.status === 'error') {
      logger.error(
        { group: group.name, error: output.error },
        'Container agent error',
      );
      return 'error';
    }

    return 'success';
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
    return 'error';
  }
}

async function startMessageLoop(): Promise<void> {
  if (messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  messageLoopRunning = true;

  logger.info(`NanoClaw running (default trigger: ${DEFAULT_TRIGGER})`);

  while (true) {
    try {
      const jids = Object.keys(registeredGroups);
      const { messages, newTimestamp } = getNewMessages(
        jids,
        lastTimestamp,
        ASSISTANT_NAME,
      );

      if (messages.length > 0) {
        logger.info({ count: messages.length }, 'New messages');

        // Advance the "seen" cursor for all messages immediately
        lastTimestamp = newTimestamp;
        saveState();

        // Deduplicate by group
        const messagesByGroup = new Map<string, NewMessage[]>();
        for (const msg of messages) {
          const existing = messagesByGroup.get(msg.chat_jid);
          if (existing) {
            existing.push(msg);
          } else {
            messagesByGroup.set(msg.chat_jid, [msg]);
          }
        }

        for (const [chatJid, groupMessages] of messagesByGroup) {
          const group = registeredGroups[chatJid];
          if (!group) continue;

          const channel = findChannel(channels, chatJid);
          if (!channel) {
            logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
            continue;
          }

          const isMainGroup = group.isMain === true;
          const needsTrigger = !isMainGroup && group.requiresTrigger !== false;

          // For non-main groups, only act on trigger messages.
          // Non-trigger messages accumulate in DB and get pulled as
          // context when a trigger eventually arrives.
          if (needsTrigger) {
            const triggerPattern = getTriggerPattern(group.trigger);
            const allowlistCfg = loadSenderAllowlist();
            const hasTrigger = groupMessages.some(
              (m) =>
                triggerPattern.test(m.content.trim()) &&
                (m.is_from_me ||
                  isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
            );
            if (!hasTrigger) continue;
          }

          // Pull all messages since lastAgentTimestamp so non-trigger
          // context that accumulated between triggers is included.
          const allPending = getMessagesSince(
            chatJid,
            getOrRecoverCursor(chatJid),
            ASSISTANT_NAME,
            MAX_MESSAGES_PER_PROMPT,
          );
          const messagesToSend =
            allPending.length > 0 ? allPending : groupMessages;
          const formatted = formatMessages(messagesToSend, TIMEZONE);

          if (queue.sendMessage(chatJid, formatted)) {
            logger.debug(
              { chatJid, count: messagesToSend.length },
              'Piped messages to active container',
            );
            const lastTsMs = Date.parse(
              messagesToSend[messagesToSend.length - 1].timestamp,
            );
            logger.info(
              {
                chatJid,
                phase: 'msg.piped_in',
                ms: Number.isFinite(lastTsMs) ? Date.now() - lastTsMs : null,
                count: messagesToSend.length,
              },
              'Latency: messages piped into warm container',
            );
            lastAgentTimestamp[chatJid] =
              messagesToSend[messagesToSend.length - 1].timestamp;
            saveState();
            // Re-arm typing: the previous turn stopped it at status=success.
            ensureTypingActive(channel, chatJid);
          } else {
            // No active container — enqueue for a new one
            queue.enqueueMessageCheck(chatJid);
          }
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

/**
 * Startup recovery: check for unprocessed messages in registered groups.
 * Handles crash between advancing lastTimestamp and processing messages.
 */
function recoverPendingMessages(): void {
  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    const pending = getMessagesSince(
      chatJid,
      getOrRecoverCursor(chatJid),
      ASSISTANT_NAME,
      MAX_MESSAGES_PER_PROMPT,
    );
    if (pending.length > 0) {
      logger.info(
        { group: group.name, pendingCount: pending.length },
        'Recovery: found unprocessed messages',
      );
      queue.enqueueMessageCheck(chatJid);
    }
  }
}

function ensureContainerSystemRunning(): void {
  ensureContainerRuntimeRunning();
  cleanupOrphans();
}

async function main(): Promise<void> {
  ensureContainerSystemRunning();
  initDatabase();
  logger.info('Database initialized');
  loadState();

  // Ensure OneCLI agents exist for all registered groups.
  // Recovers from missed creates (e.g. OneCLI was down at registration time).
  for (const [jid, group] of Object.entries(registeredGroups)) {
    ensureOneCLIAgent(jid, group);
  }

  restoreRemoteControl();

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    await queue.shutdown(10000);
    for (const ch of channels) await ch.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Handle /remote-control and /remote-control-end commands
  async function handleRemoteControl(
    command: string,
    chatJid: string,
    msg: NewMessage,
  ): Promise<void> {
    const group = registeredGroups[chatJid];
    if (!group?.isMain) {
      logger.warn(
        { chatJid, sender: msg.sender },
        'Remote control rejected: not main group',
      );
      return;
    }

    const channel = findChannel(channels, chatJid);
    if (!channel) return;

    if (command === '/remote-control') {
      const result = await startRemoteControl(
        msg.sender,
        chatJid,
        process.cwd(),
      );
      if (result.ok) {
        await channel.sendMessage(chatJid, result.url);
      } else {
        await channel.sendMessage(
          chatJid,
          `Remote Control failed: ${result.error}`,
        );
      }
    } else {
      const result = stopRemoteControl();
      if (result.ok) {
        await channel.sendMessage(chatJid, 'Remote Control session ended.');
      } else {
        await channel.sendMessage(chatJid, result.error);
      }
    }
  }

  // Channel callbacks (shared by all channels)
  const channelOpts = {
    // Channel-side hook fired BEFORE the channel's registered-groups gate.
    // Lets us auto-register an unsolicited DM sender so the gate succeeds on
    // the same event. No rate limiting here — that lives in onMessage so it
    // also covers subsequent messages from already-registered open_dm groups.
    tryAutoRegister: (chatJid: string) => {
      if (registeredGroups[chatJid]) return;
      const openMode = loadOpenMode(registeredGroups);
      if (!openMode?.enabled) return;
      const decision = evaluateOpenMode(chatJid, registeredGroups);
      if (!decision.eligible || !decision.group) {
        logger.debug(
          { chatJid, reason: decision.reason },
          'open-mode: not eligible for onboarding',
        );
        return;
      }
      try {
        registerGroup(chatJid, decision.group);
        logger.info(
          { chatJid, folder: decision.group.folder },
          'open-mode: onboarded new sender',
        );
      } catch (err) {
        logger.error({ chatJid, err }, 'open-mode: registerGroup failed');
      }
    },
    onMessage: (chatJid: string, msg: NewMessage) => {
      // Remote control commands — intercept before storage
      const trimmed = msg.content.trim();
      if (trimmed === '/remote-control' || trimmed === '/remote-control-end') {
        handleRemoteControl(trimmed, chatJid, msg).catch((err) =>
          logger.error({ err, chatJid }, 'Remote control command error'),
        );
        return;
      }

      // Open DM rate limit: applies to open_dm groups (both freshly auto-
      // registered and ones receiving subsequent messages). Skips human DMs
      // for any other profile so legacy registered DMs are unaffected.
      if (
        !msg.is_from_me &&
        !msg.is_bot_message &&
        registeredGroups[chatJid]?.containerConfig?.agentProfile === 'open_dm'
      ) {
        const openMode = loadOpenMode(registeredGroups);
        if (openMode?.rateLimit) {
          const rl = openConsumeRateLimit(msg.sender, openMode.rateLimit);
          if (!rl.allowed) {
            const channel = findChannel(channels, chatJid);
            if (channel) {
              const mins = Math.max(1, Math.ceil(rl.retryAfterSec / 60));
              channel
                .sendMessage(
                  chatJid,
                  `I can only handle a few messages per hour. Please retry in ~${mins} min.`,
                )
                .catch((err) =>
                  logger.warn(
                    { chatJid, err },
                    'open-mode: rate-limit reply failed',
                  ),
                );
            }
            logger.info(
              { chatJid, sender: msg.sender, retryAfterSec: rl.retryAfterSec },
              'open-mode: rate-limited inbound',
            );
            return;
          }
        }
      }

      // Sender allowlist drop mode: discard messages from denied senders before storing
      if (!msg.is_from_me && !msg.is_bot_message && registeredGroups[chatJid]) {
        const cfg = loadSenderAllowlist();
        if (
          shouldDropMessage(chatJid, cfg) &&
          !isSenderAllowed(chatJid, msg.sender, cfg)
        ) {
          if (cfg.logDenied) {
            logger.debug(
              { chatJid, sender: msg.sender },
              'sender-allowlist: dropping message (drop mode)',
            );
          }
          return;
        }
      }
      storeMessage(msg);
    },
    onChatMetadata: (
      chatJid: string,
      timestamp: string,
      name?: string,
      channel?: string,
      isGroup?: boolean,
    ) => storeChatMetadata(chatJid, timestamp, name, channel, isGroup),
    registeredGroups: () => registeredGroups,
  };

  // Create and connect all registered channels.
  // Each channel self-registers via the barrel import above.
  // Factories return null when credentials are missing, OR one
  // channel per pairing for kinds that support multiple instances
  // (WhatsApp — multi-agent-completion-blueprint § 4.1).
  for (const channelName of getRegisteredChannelNames()) {
    const factory = getChannelFactory(channelName)!;
    const instances = normaliseFactoryResult(factory(channelOpts));
    if (instances.length === 0) {
      logger.warn(
        { channel: channelName },
        'Channel installed but credentials missing — skipping. Check .env or re-run the channel skill.',
      );
      continue;
    }
    for (const channel of instances) {
      channels.push(channel);
      await channel.connect();
    }
    if (instances.length > 1) {
      logger.info(
        { channel: channelName, instances: instances.length },
        'Channel kind started multiple pairings',
      );
    }
  }
  if (channels.length === 0) {
    logger.fatal('No channels connected');
    process.exit(1);
  }

  // Start subsystems (independently of connection handler)
  startSchedulerLoop({
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    queue,
    onProcess: (groupJid, proc, containerName, groupFolder) =>
      queue.registerProcess(groupJid, proc, containerName, groupFolder),
    sendMessage: async (jid, rawText) => {
      const channel = findChannel(channels, jid);
      if (!channel) {
        logger.warn({ jid }, 'No channel owns JID, cannot send message');
        return;
      }
      const text = formatOutbound(rawText);
      if (text) await channel.sendMessage(jid, text);
    },
  });
  startIpcWatcher({
    sendMessage: (jid, text) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      return channel.sendMessage(jid, text);
    },
    registeredGroups: () => registeredGroups,
    registerGroup,
    syncGroups: async (force: boolean) => {
      await Promise.all(
        channels
          .filter((ch) => ch.syncGroups)
          .map((ch) => ch.syncGroups!(force)),
      );
    },
    getAvailableGroups,
    writeGroupsSnapshot: (gf, im, ag, rj) =>
      writeGroupsSnapshot(gf, im, ag, rj),
    onTasksChanged: () => {
      const tasks = getAllTasks();
      const taskRows = tasks.map((t) => ({
        id: t.id,
        groupFolder: t.group_folder,
        prompt: t.prompt,
        script: t.script || undefined,
        schedule_type: t.schedule_type,
        schedule_value: t.schedule_value,
        status: t.status,
        next_run: t.next_run,
      }));
      for (const group of Object.values(registeredGroups)) {
        writeTasksSnapshot(group.folder, group.isMain === true, taskRows);
      }
    },
  });
  queue.setProcessMessagesFn(processGroupMessages);
  recoverPendingMessages();

  // Start the HTTP server for the Factotem dashboard's /health and
  // /api/* routes. Tailscale-local; no app-level auth in v1.
  // T-1778233000000 (Phase 0.1) + T-1778236000000 (Phase 0.5).
  startHttpServer({
    getRegisteredGroups: () => registeredGroups,
    reloadConfig: () => {
      try {
        process.kill(process.pid, 'SIGHUP');
      } catch (err) {
        logger.warn({ err }, 'reloadConfig: failed to send SIGHUP to self');
      }
    },
    injectIpcMessage: (groupFolder, text) => {
      const ipcInputDir = path.join(DATA_DIR, 'ipc', groupFolder, 'input');
      fs.mkdirSync(ipcInputDir, { recursive: true });
      const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
      const tempPath = path.join(ipcInputDir, `${filename}.tmp`);
      const finalPath = path.join(ipcInputDir, filename);
      fs.writeFileSync(tempPath, JSON.stringify({ type: 'message', text }));
      fs.renameSync(tempPath, finalPath);
    },
  });

  // SIGHUP handler — reload registeredGroups from DB without a full
  // service restart. Triggered by the dashboard API after a PATCH to
  // a group's container_config. In-flight containers continue on the
  // old config (kill-on-apply per blueprint v2 § "Phase 8 — Operator-
  // action safety"; drain semantics are tracked under T-1777809840000
  // R4 and out of scope for v1).
  process.on('SIGHUP', () => {
    try {
      const next = getAllRegisteredGroups();
      registeredGroups = next;
      logger.info(
        { groupCount: Object.keys(next).length },
        'SIGHUP: reloaded registered groups from DB',
      );
    } catch (err) {
      logger.error({ err }, 'SIGHUP: reload failed');
    }
  });

  startMessageLoop().catch((err) => {
    logger.fatal({ err }, 'Message loop crashed unexpectedly');
    process.exit(1);
  });
}

// Guard: only run when executed directly, not when imported by tests
const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname ===
    new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start NanoClaw');
    process.exit(1);
  });
}
