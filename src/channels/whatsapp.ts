import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';

import pino from 'pino';
import makeWASocket, {
  Browsers,
  DisconnectReason,
  downloadMediaMessage,
  WAMessageKey,
  WASocket,
  fetchLatestWaWebVersion,
  makeCacheableSignalKeyStore,
  normalizeMessageContent,
  proto,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';

// Baileys requires a pino-compatible logger instance
const baileysLogger = pino({ level: 'silent' });

import {
  ASSISTANT_HAS_OWN_NUMBER,
  ASSISTANT_NAME,
  GROUPS_DIR,
  STORE_DIR,
} from '../config.js';
import { getLastGroupSync, setLastGroupSync, updateChatName } from '../db.js';
import { isImageMessage, processImage } from '../image.js';
import { logger } from '../logger.js';
import { isVoiceMessage, transcribeAudioMessage } from '../transcription.js';
import {
  Channel,
  MessageMetadata,
  OnInboundMessage,
  OnChatMetadata,
  RegisteredGroup,
} from '../types.js';
import { secureAuthDir } from './auth-permissions.js';
import {
  type ChannelPairing,
  getDefaultPairing,
  getPairingForChat,
  listPairingsForKind,
  recordChatPairing,
  recordPairingConnected,
} from './pairings.js';
import { registerChannel, ChannelOpts } from './registry.js';

const GROUP_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

function formatModelName(model: string): string {
  if (model.includes('opus')) return 'Opus';
  if (model.includes('sonnet')) return 'Sonnet';
  if (model.includes('haiku')) return 'Haiku';
  // Fallback: extract the model family name
  const parts = model.split('-');
  if (parts.length >= 2) return parts.slice(0, 2).join(' ');
  return model;
}

export interface WhatsAppChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  // Optional hook fired when an unregistered chat sends a message. The
  // orchestrator may auto-register the JID (open_dm mode) so the gate
  // below succeeds on the SAME event. Synchronous so re-fetching
  // registeredGroups() afterward sees any new registration.
  tryAutoRegister?: (chatJid: string) => void;
  /**
   * The pairing this channel instance represents. The deployment may
   * run several `WhatsAppChannel`s simultaneously, one per pairing —
   * each with its own auth directory and Baileys session. Optional
   * for backward compatibility with code paths that haven't been
   * updated yet; defaults to the kind's shared pairing.
   *
   * See multi-agent-completion-blueprint § 4.1.
   */
  pairing?: ChannelPairing;
}

export class WhatsAppChannel implements Channel {
  /**
   * Channel name is `whatsapp:<pairing_id>`. The deployment can have
   * multiple WhatsApp channels coexisting — one per pairing. The
   * legacy single-channel deployment's pairing id is `whatsapp-shared`
   * (synthesised on migration), so the name resolves to
   * `whatsapp:whatsapp-shared` after upgrade. Routers that match on
   * channel name use the full `whatsapp:<id>` form; routers that just
   * branch on channel kind can split on the `:` prefix.
   */
  name: string;

  /** Pairing id this channel instance owns. */
  private pairingId: string;
  /** Operator-facing label, surfaced in `/health` + dashboard. */
  private displayName: string;
  /** Filesystem path where Baileys writes this pairing's creds. */
  private authPath: string;

  private sock!: WASocket;
  private connected = false;
  private lidToPhoneMap: Record<string, string> = {};
  private outgoingQueue: Array<{ jid: string; text: string }> = [];
  private flushing = false;
  private groupSyncTimerStarted = false;
  /** Cache of recently sent messages for retry requests (max 256 entries). */
  private sentMessageCache = new Map<string, proto.IMessage>();
  /** Bot's LID user ID (e.g. "80355281346633") for normalizing group mentions. */
  private botLidUser?: string;

  private opts: WhatsAppChannelOpts;

  constructor(opts: WhatsAppChannelOpts) {
    this.opts = opts;
    // Resolve the pairing for this instance. Explicit pairing wins;
    // otherwise read the deployment's shared WhatsApp pairing (which
    // the migration synthesised from store/auth/ on first boot).
    const resolved =
      opts.pairing ?? getDefaultPairing('whatsapp') ?? null;
    if (resolved) {
      this.pairingId = resolved.id;
      this.displayName = resolved.display_name;
      this.authPath = resolved.auth_path;
    } else {
      // Fallback for the genuine first-boot case where the migration
      // hasn't run yet (pre-v1.2.1 install): use the legacy hardcoded
      // path so existing operators don't see a re-pair prompt. The
      // pairing row gets synthesised on the next orchestrator start.
      this.pairingId = 'whatsapp-shared';
      this.displayName = 'Shared WhatsApp';
      this.authPath = path.join(STORE_DIR, 'auth');
    }
    this.name = `whatsapp:${this.pairingId}`;
  }

  async connect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.connectInternal(resolve).catch(reject);
    });
  }

  private async connectInternal(onFirstOpen?: () => void): Promise<void> {
    // Per-pairing auth directory. The shared (legacy) pairing reuses
    // `store/auth/`; new pairings get their own isolated dirs (e.g.
    // `store/auth-whatsapp-ben/`). This is the single change that
    // makes multi-WhatsApp possible — Baileys reads/writes credentials
    // and session keys from this directory exclusively.
    const authDir = this.authPath;
    fs.mkdirSync(authDir, { recursive: true });

    // Tighten auth file permissions to 0o600 (initial walk + fs.watch).
    // Baileys writes session keys + pre-keys + sender-keys throughout
    // runtime; default umask leaves them world-readable, which is a real
    // exposure on multi-user hosts. T-1778237000000 (Phase 0.6).
    secureAuthDir(authDir);

    const { state, saveCreds } = await useMultiFileAuthState(authDir);

    const { version } = await fetchLatestWaWebVersion({}).catch((err) => {
      logger.warn(
        { err },
        'Failed to fetch latest WA Web version, using default',
      );
      return { version: undefined };
    });
    this.sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, baileysLogger),
      },
      printQRInTerminal: false,
      logger: baileysLogger,
      browser: Browsers.macOS('Chrome'),
      getMessage: async (key: WAMessageKey) => {
        const cached = this.sentMessageCache.get(key.id || '');
        if (cached) {
          logger.debug(
            { id: key.id },
            'getMessage: returning cached message for retry',
          );
          return cached;
        }
        logger.debug({ id: key.id }, 'getMessage: no cached message found');
        return undefined;
      },
    });

    this.sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        const msg =
          'WhatsApp authentication required. Run /setup in Claude Code.';
        logger.error(msg);
        exec(
          `osascript -e 'display notification "${msg}" with title "NanoClaw" sound name "Basso"'`,
        );
        setTimeout(() => process.exit(1), 1000);
      }

      if (connection === 'close') {
        this.connected = false;
        const reason = (
          lastDisconnect?.error as { output?: { statusCode?: number } }
        )?.output?.statusCode;
        const shouldReconnect = reason !== DisconnectReason.loggedOut;
        logger.info(
          {
            reason,
            shouldReconnect,
            queuedMessages: this.outgoingQueue.length,
          },
          'Connection closed',
        );

        if (shouldReconnect) {
          this.scheduleReconnect(1, onFirstOpen);
        } else {
          logger.info('Logged out. Run /setup to re-authenticate.');
          process.exit(0);
        }
      } else if (connection === 'open') {
        this.connected = true;
        recordPairingConnected(this.pairingId);
        logger.info(
          { pairingId: this.pairingId, displayName: this.displayName },
          'Connected to WhatsApp',
        );

        // Announce availability so WhatsApp relays subsequent presence updates (typing indicators)
        this.sock.sendPresenceUpdate('available').catch((err) => {
          logger.warn({ err }, 'Failed to send presence update');
        });

        // Build LID to phone mapping from auth state for self-chat translation
        if (this.sock.user) {
          const phoneUser = this.sock.user.id.split(':')[0];
          const lidUser = this.sock.user.lid?.split(':')[0];
          if (lidUser && phoneUser) {
            this.lidToPhoneMap[lidUser] = `${phoneUser}@s.whatsapp.net`;
            this.botLidUser = lidUser;
            logger.debug({ lidUser, phoneUser }, 'LID to phone mapping set');
          }
        }

        // Flush any messages queued while disconnected
        this.flushOutgoingQueue().catch((err) =>
          logger.error({ err }, 'Failed to flush outgoing queue'),
        );

        // Sync group metadata on startup (respects 24h cache)
        this.syncGroupMetadata().catch((err) =>
          logger.error({ err }, 'Initial group sync failed'),
        );
        // Set up daily sync timer (only once)
        if (!this.groupSyncTimerStarted) {
          this.groupSyncTimerStarted = true;
          setInterval(() => {
            this.syncGroupMetadata().catch((err) =>
              logger.error({ err }, 'Periodic group sync failed'),
            );
          }, GROUP_SYNC_INTERVAL_MS);
        }

        // Signal first connection to caller
        if (onFirstOpen) {
          onFirstOpen();
          onFirstOpen = undefined;
        }
      }
    });

    this.sock.ev.on('creds.update', saveCreds);

    this.sock.ev.on('messages.upsert', async ({ messages }) => {
      for (const msg of messages) {
        try {
          if (!msg.message) continue;
          // Unwrap container types (viewOnceMessageV2, ephemeralMessage,
          // editedMessage, etc.) so that conversation, extendedTextMessage,
          // imageMessage, etc. are accessible at the top level.
          const normalized = normalizeMessageContent(msg.message);
          if (!normalized) continue;
          const rawJid = msg.key.remoteJid;
          if (!rawJid || rawJid === 'status@broadcast') continue;

          // Translate LID JID to phone JID if applicable.
          // Prefer senderPn from the message key (available in newer WA protocol)
          // since translateJid may fail to resolve LID→phone via signalRepository.
          let chatJid = await this.translateJid(rawJid);
          if (chatJid.endsWith('@lid') && (msg.key as any).senderPn) {
            const pn = (msg.key as any).senderPn as string;
            const phoneJid = pn.includes('@') ? pn : `${pn}@s.whatsapp.net`;
            this.lidToPhoneMap[rawJid.split('@')[0].split(':')[0]] = phoneJid;
            chatJid = phoneJid;
            logger.info(
              { lidJid: rawJid, phoneJid },
              'Translated LID via senderPn',
            );
          }

          const timestamp = new Date(
            Number(msg.messageTimestamp) * 1000,
          ).toISOString();

          // Always notify about chat metadata for group discovery
          const isGroup = chatJid.endsWith('@g.us');
          this.opts.onChatMetadata(
            chatJid,
            timestamp,
            undefined,
            'whatsapp',
            isGroup,
          );

          // Multi-pairing arbitration: stamp the chat's pairing_id
          // so subsequent inbound + outbound routes through this
          // pairing's channel instance. Idempotent — repeated
          // inbounds re-confirm the binding without overwriting it
          // with a different pairing. See
          // multi-agent-completion-blueprint § 4.1.
          recordChatPairing(chatJid, this.pairingId);

          // Only deliver full message for registered groups.
          // Give the orchestrator a chance to auto-register first
          // (open_dm mode for unsolicited DM senders). Skip auto-register
          // for our own outbound — Baileys fires upsert for fromMe messages
          // (incl. echoes from other linked devices) and the chatJid in
          // those events can be the bot's own JID, which we must not onboard.
          let groups = this.opts.registeredGroups();
          if (
            !groups[chatJid] &&
            !msg.key.fromMe &&
            this.opts.tryAutoRegister
          ) {
            this.opts.tryAutoRegister(chatJid);
            groups = this.opts.registeredGroups();
          }
          if (groups[chatJid]) {
            let content =
              normalized.conversation ||
              normalized.extendedTextMessage?.text ||
              normalized.imageMessage?.caption ||
              normalized.videoMessage?.caption ||
              '';

            // WhatsApp group mentions use the LID in raw text (e.g. "@80355281346633")
            // instead of the display name. Normalize to @AssistantName for trigger matching.
            if (this.botLidUser && content.includes(`@${this.botLidUser}`)) {
              content = content.replace(
                `@${this.botLidUser}`,
                `@${ASSISTANT_NAME}`,
              );
            }

            // Spreadsheet/document attachment handling
            const docMime = normalized?.documentMessage?.mimetype || '';
            const EXCEL_MIMETYPES = [
              'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
              'application/vnd.ms-excel',
              'application/vnd.ms-excel.sheet.macroenabled.12',
              'text/csv',
              'application/csv',
            ];
            if (
              normalized?.documentMessage &&
              EXCEL_MIMETYPES.includes(docMime)
            ) {
              try {
                const buffer = await downloadMediaMessage(msg, 'buffer', {});
                const groupDir = path.join(GROUPS_DIR, groups[chatJid].folder);
                const attachDir = path.join(groupDir, 'attachments');
                fs.mkdirSync(attachDir, { recursive: true });
                const filename = path.basename(
                  normalized.documentMessage.fileName ||
                    `doc-${Date.now()}.xlsx`,
                );
                const filePath = path.join(attachDir, filename);
                fs.writeFileSync(filePath, buffer as Buffer);
                const sizeKB = Math.round((buffer as Buffer).length / 1024);
                const docRef = `[Document: attachments/${filename} (${sizeKB}KB)]\nUse: excel-reader extract attachments/${filename}`;
                const caption = normalized.documentMessage.caption || '';
                content = caption ? `${caption}\n\n${docRef}` : docRef;
                logger.info(
                  { jid: chatJid, filename },
                  'Downloaded spreadsheet attachment',
                );
              } catch (err) {
                logger.warn(
                  { err, jid: chatJid },
                  'Failed to download spreadsheet attachment',
                );
              }
            }

            // PDF attachment handling
            if (normalized?.documentMessage?.mimetype === 'application/pdf') {
              try {
                const buffer = await downloadMediaMessage(msg, 'buffer', {});
                const groupDir = path.join(GROUPS_DIR, groups[chatJid].folder);
                const attachDir = path.join(groupDir, 'attachments');
                fs.mkdirSync(attachDir, { recursive: true });
                const filename = path.basename(
                  normalized.documentMessage.fileName ||
                    `doc-${Date.now()}.pdf`,
                );
                const filePath = path.join(attachDir, filename);
                fs.writeFileSync(filePath, buffer as Buffer);
                const sizeKB = Math.round((buffer as Buffer).length / 1024);
                const pdfRef = `[PDF: attachments/${filename} (${sizeKB}KB)]\nUse: pdf-reader extract attachments/${filename}`;
                const caption = normalized.documentMessage.caption || '';
                content = caption ? `${caption}\n\n${pdfRef}` : pdfRef;
                logger.info(
                  { jid: chatJid, filename },
                  'Downloaded PDF attachment',
                );
              } catch (err) {
                logger.warn(
                  { err, jid: chatJid },
                  'Failed to download PDF attachment',
                );
              }
            }

            // Image attachment handling
            if (isImageMessage(msg)) {
              try {
                const buffer = await downloadMediaMessage(msg, 'buffer', {});
                const groupDir = path.join(GROUPS_DIR, groups[chatJid].folder);
                const caption = normalized?.imageMessage?.caption ?? '';
                const result = await processImage(
                  buffer as Buffer,
                  groupDir,
                  caption,
                );
                if (result) {
                  content = result.content;
                }
              } catch (err) {
                logger.warn({ err, jid: chatJid }, 'Image - download failed');
              }
            }

            // Skip protocol messages with no text content (encryption keys, read receipts, etc.)
            // but allow voice messages through for transcription
            if (!content && !isVoiceMessage(msg)) continue;

            const sender = msg.key.participant || msg.key.remoteJid || '';
            const senderName = msg.pushName || sender.split('@')[0];

            const fromMe = msg.key.fromMe || false;
            // Detect bot messages: with own number, fromMe is reliable
            // since only the bot sends from that number.
            // With shared number, bot messages carry the assistant name prefix
            // (even in DMs/self-chat) so we check for that.
            const isBotMessage = ASSISTANT_HAS_OWN_NUMBER
              ? fromMe
              : content.startsWith(`👱🏻‍♂️${ASSISTANT_NAME} here...`) ||
                content.startsWith(`${ASSISTANT_NAME}:`);

            // Transcribe voice messages before storing
            let finalContent = content;
            if (isVoiceMessage(msg)) {
              try {
                const transcript = await transcribeAudioMessage(msg, this.sock);
                if (transcript) {
                  finalContent = `[Voice: ${transcript}]`;
                  logger.info(
                    { chatJid, length: transcript.length },
                    'Transcribed voice message',
                  );
                } else {
                  finalContent = '[Voice Message - transcription unavailable]';
                }
              } catch (err) {
                logger.error({ err }, 'Voice transcription error');
                finalContent = '[Voice Message - transcription failed]';
              }
            }

            this.opts.onMessage(chatJid, {
              id: msg.key.id || '',
              chat_jid: chatJid,
              sender,
              sender_name: senderName,
              content: finalContent,
              timestamp,
              is_from_me: fromMe,
              is_bot_message: isBotMessage,
            });
          } else if (chatJid !== rawJid) {
            // LID translation produced a JID that doesn't match any registered group
            logger.warn(
              {
                rawJid,
                translatedJid: chatJid,
                registeredJids: Object.keys(groups),
              },
              'Message JID not found in registered groups after translation',
            );
          }
        } catch (err) {
          logger.error(
            { err, remoteJid: msg.key?.remoteJid },
            'Error processing incoming message',
          );
        }
      }
    });
  }

  async sendMessage(
    jid: string,
    text: string,
    metadata?: MessageMetadata,
  ): Promise<void> {
    // Prefix bot messages with assistant name so users know who's speaking.
    // On a shared number, prefix is also needed in DMs (including self-chat)
    // to distinguish bot output from user messages.
    // Skip only when the assistant has its own dedicated phone number.
    const modelLabel = metadata?.model
      ? ` (${formatModelName(metadata.model)})`
      : '';
    const prefixed = ASSISTANT_HAS_OWN_NUMBER
      ? text
      : `👱🏻‍♂️${ASSISTANT_NAME} here...${modelLabel}\n\n${text}`;

    if (!this.connected) {
      this.outgoingQueue.push({ jid, text: prefixed });
      logger.info(
        { jid, length: prefixed.length, queueSize: this.outgoingQueue.length },
        'WA disconnected, message queued',
      );
      return;
    }
    try {
      const sent = await this.sock.sendMessage(jid, { text: prefixed });
      // Cache for retry requests (recipient may ask us to re-encrypt)
      if (sent?.key?.id && sent.message) {
        this.sentMessageCache.set(sent.key.id, sent.message);
        if (this.sentMessageCache.size > 256) {
          const oldest = this.sentMessageCache.keys().next().value!;
          this.sentMessageCache.delete(oldest);
        }
      }
      logger.info({ jid, length: prefixed.length }, 'Message sent');
    } catch (err) {
      // If send fails, queue it for retry on reconnect
      this.outgoingQueue.push({ jid, text: prefixed });
      logger.warn(
        { jid, err, queueSize: this.outgoingQueue.length },
        'Failed to send, message queued',
      );
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  /**
   * Pairing id surfaced to the router. Used to disambiguate when
   * multiple WhatsApp channels are running — the router looks up the
   * chat's recorded `pairing_id` and matches against this getter.
   */
  getPairingId(): string {
    return this.pairingId;
  }

  /** Display label for `/health` and dashboard. */
  getDisplayName(): string {
    return this.displayName;
  }

  ownsJid(jid: string): boolean {
    // Pre-flight JID-shape check — only WhatsApp-shaped JIDs ever
    // match. Telegram / Slack / Discord channels return false here.
    if (!jid.endsWith('@g.us') && !jid.endsWith('@s.whatsapp.net')) {
      return false;
    }
    // Single-pairing deployment (the v1.0 / v1.2 default): no
    // ambiguity, this channel owns every WhatsApp JID.
    const pairings = listPairingsForKind('whatsapp');
    if (pairings.length <= 1) return true;

    // Multi-pairing deployment: only the channel whose pairing
    // matches the chat's recorded pairing owns the JID. The chat row
    // is stamped by the inbound handler on first message (see
    // recordChatPairing below). For brand-new JIDs that haven't been
    // stamped yet, the shared pairing claims ownership so the
    // existing v1.0 routing path keeps working.
    const chatPairing = getPairingForChat(jid);
    if (chatPairing) {
      return chatPairing.id === this.pairingId;
    }
    // Unknown JID — only the shared pairing claims it. This prevents
    // a non-shared pairing from receiving inbound for a JID it
    // wasn't paired with.
    const shared = getDefaultPairing('whatsapp');
    return shared?.id === this.pairingId;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.sock?.end(undefined);
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    try {
      const status = isTyping ? 'composing' : 'paused';
      logger.debug({ jid, status }, 'Sending presence update');
      await this.sock.sendPresenceUpdate(status, jid);
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to update typing status');
    }
  }

  async syncGroups(force: boolean): Promise<void> {
    return this.syncGroupMetadata(force);
  }

  /**
   * Sync group metadata from WhatsApp.
   * Fetches all participating groups and stores their names in the database.
   * Called on startup, daily, and on-demand via IPC.
   */
  async syncGroupMetadata(force = false): Promise<void> {
    if (!force) {
      const lastSync = getLastGroupSync();
      if (lastSync) {
        const lastSyncTime = new Date(lastSync).getTime();
        if (Date.now() - lastSyncTime < GROUP_SYNC_INTERVAL_MS) {
          logger.debug({ lastSync }, 'Skipping group sync - synced recently');
          return;
        }
      }
    }

    try {
      logger.info('Syncing group metadata from WhatsApp...');
      const groups = await this.sock.groupFetchAllParticipating();

      let count = 0;
      for (const [jid, metadata] of Object.entries(groups)) {
        if (metadata.subject) {
          updateChatName(jid, metadata.subject);
          count++;
        }
      }

      setLastGroupSync();
      logger.info({ count }, 'Group metadata synced');
    } catch (err) {
      logger.error({ err }, 'Failed to sync group metadata');
    }
  }

  private scheduleReconnect(attempt: number, onFirstOpen?: () => void): void {
    const delayMs = Math.min(5000 * Math.pow(2, attempt - 1), 300000);
    logger.info({ attempt, delayMs }, 'Reconnecting...');
    setTimeout(() => {
      this.connectInternal(onFirstOpen).catch((err) => {
        logger.error({ err, attempt }, 'Reconnection attempt failed');
        this.scheduleReconnect(attempt + 1, onFirstOpen);
      });
    }, delayMs);
  }

  private async translateJid(jid: string): Promise<string> {
    if (!jid.endsWith('@lid')) return jid;
    const lidUser = jid.split('@')[0].split(':')[0];

    // Check local cache first
    const cached = this.lidToPhoneMap[lidUser];
    if (cached) {
      logger.debug(
        { lidJid: jid, phoneJid: cached },
        'Translated LID to phone JID (cached)',
      );
      return cached;
    }

    // Query Baileys' signal repository for the mapping
    try {
      const pn = await (
        this.sock.signalRepository as any
      )?.lidMapping?.getPNForLID(jid);
      if (pn) {
        const phoneJid = `${pn.split('@')[0].split(':')[0]}@s.whatsapp.net`;
        this.lidToPhoneMap[lidUser] = phoneJid;
        logger.info(
          { lidJid: jid, phoneJid },
          'Translated LID to phone JID (signalRepository)',
        );
        return phoneJid;
      }
    } catch (err) {
      logger.debug({ err, jid }, 'Failed to resolve LID via signalRepository');
    }

    return jid;
  }

  private async flushOutgoingQueue(): Promise<void> {
    if (this.flushing || this.outgoingQueue.length === 0) return;
    this.flushing = true;
    try {
      logger.info(
        { count: this.outgoingQueue.length },
        'Flushing outgoing message queue',
      );
      while (this.outgoingQueue.length > 0) {
        const item = this.outgoingQueue.shift()!;
        // Send directly — queued items are already prefixed by sendMessage
        const sent = await this.sock.sendMessage(item.jid, { text: item.text });
        if (sent?.key?.id && sent.message) {
          this.sentMessageCache.set(sent.key.id, sent.message);
        }
        logger.info(
          { jid: item.jid, length: item.text.length },
          'Queued message sent',
        );
      }
    } finally {
      this.flushing = false;
    }
  }
}

registerChannel('whatsapp', (opts: ChannelOpts) => {
  // Multi-agent-completion-blueprint § 4.1: per-pairing instantiation.
  // The factory returns one WhatsAppChannel per row in
  // channel_pairings (one for v1.0 deployments, more once operators
  // add per-agent pairings via the wizard's H.5 flow). The boot loop
  // normalises the array via normaliseFactoryResult.
  //
  // First-boot fallback: if the migration hasn't created the
  // whatsapp-shared row yet (extremely rare — only on a brand-new DB
  // before init), instantiate one channel with no pairing arg. The
  // channel falls back to the legacy `store/auth/` path so the
  // operator's existing creds keep working.
  const pairings = listPairingsForKind('whatsapp');
  if (pairings.length === 0) {
    return new WhatsAppChannel(opts);
  }
  return pairings.map(
    (pairing) => new WhatsAppChannel({ ...opts, pairing }),
  );
});
