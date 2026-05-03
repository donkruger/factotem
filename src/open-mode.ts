/**
 * Open DM mode: decide whether to onboard an unsolicited DM sender.
 *
 * The actual registration is performed by the orchestrator's existing
 * registerGroup helper so the new open_dm group gets the same setup
 * (folder creation, OneCLI agent provisioning, etc.) as any other group.
 * This module only computes the policy decision and constructs the group.
 */

import fs from 'fs';
import path from 'path';

import { STORE_DIR } from './config.js';
import { getOpenSpendForDate, recordOpenSpend } from './db.js';
import { logger } from './logger.js';
import { OpenModeConfig, RegisteredGroup } from './types.js';

const DEFAULT_EST_COST_CENTS_PER_INVOCATION = 4;

// Cache the bot's own phone JID parsed from store/auth/creds.json.
// `me.id` looks like "27752007263:6@s.whatsapp.net"; we strip the device
// suffix to get "27752007263@s.whatsapp.net" since that's the form chatJid
// arrives in after Baileys' translation.
//
// The cache is module-scoped (lives for the process lifetime). Re-pairing
// (which writes a new creds.json with a different `me.id`) requires a
// NanoClaw restart to take effect — same constraint as everything else
// that reads creds.json on startup.
let cachedBotPhoneJid: string | null | undefined;
function getBotPhoneJid(): string | null {
  if (cachedBotPhoneJid !== undefined) return cachedBotPhoneJid;
  try {
    const credsPath = path.join(STORE_DIR, 'auth', 'creds.json');
    const raw = fs.readFileSync(credsPath, 'utf-8');
    const creds = JSON.parse(raw) as { me?: { id?: string } };
    const meId = creds?.me?.id;
    if (typeof meId !== 'string') {
      cachedBotPhoneJid = null;
      return null;
    }
    // Strip ":<deviceId>" before "@" so "27752007263:6@s.whatsapp.net"
    // becomes "27752007263@s.whatsapp.net".
    cachedBotPhoneJid = meId.replace(/:\d+(@)/, '$1');
    return cachedBotPhoneJid;
  } catch (err) {
    logger.warn(
      { err },
      'open-mode: cannot read creds.json; bot-self filter disabled (channel-side fromMe filter still applies)',
    );
    cachedBotPhoneJid = null;
    return null;
  }
}

/**
 * Find the openMode config to consult. Lives on the main group's
 * containerConfig (single source of truth per NanoClaw process).
 * Returns undefined if no main group exists or openMode is not configured.
 */
export function loadOpenMode(
  registeredGroups: Record<string, RegisteredGroup>,
): OpenModeConfig | undefined {
  for (const group of Object.values(registeredGroups)) {
    if (group.isMain && group.containerConfig?.openMode) {
      return group.containerConfig.openMode;
    }
  }
  return undefined;
}

/**
 * Returns true iff a JID looks like a personal WhatsApp DM. Group JIDs
 * (`@g.us`) and other channel namespaces (`tg:`, `dc:`) are explicitly
 * excluded — strangers adding the bot to a group is a separate threat model.
 *
 * Also accepts `@lid` (WhatsApp Multi-Device LID) because first-contact
 * senders frequently arrive with chatJid still as the LID — Baileys'
 * `senderPn`-based translation only succeeds once key exchange completes,
 * which for a brand-new sender often hasn't happened yet. Treating LID as
 * a valid DM identifier is the only way the open_dm path works for true
 * strangers. The agent's reply via `send_self` routes back to the same
 * `@lid` and WhatsApp resolves it correctly.
 */
function isOpenableDmJid(chatJid: string): boolean {
  return chatJid.endsWith('@s.whatsapp.net') || chatJid.endsWith('@lid');
}

function todayUtcDate(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Sanitize a phone JID into a folder slug. WhatsApp JIDs are alphanumeric +
 * `@`/`.`/`:` — strip those down to characters allowed by the group-folder
 * validator (`^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`).
 */
function jidToFolderSlug(chatJid: string): string {
  const local = chatJid.split('@')[0] ?? chatJid;
  return local.replace(/[^A-Za-z0-9-]/g, '-').slice(0, 40);
}

export interface OpenModeDecision {
  // True iff the orchestrator should call registerGroup with `group`.
  eligible: boolean;
  group?: RegisteredGroup;
  // Stable reason code for logging / future metrics.
  reason: string;
}

/**
 * Decide whether an unregistered inbound JID should be auto-onboarded as an
 * open_dm group. Caller is responsible for the actual registration.
 *
 * Fail-closed: if openMode.enabled is true but dailyBudgetCents is null
 * or undefined, we refuse to onboard. The operator must consciously set
 * a budget before strangers can reach the agent path.
 */
export function evaluateOpenMode(
  chatJid: string,
  registeredGroups: Record<string, RegisteredGroup>,
): OpenModeDecision {
  if (registeredGroups[chatJid]) {
    return { eligible: false, reason: 'already_registered' };
  }
  const openMode = loadOpenMode(registeredGroups);
  if (!openMode || !openMode.enabled) {
    return { eligible: false, reason: 'open_mode_disabled' };
  }
  if (!isOpenableDmJid(chatJid)) {
    return { eligible: false, reason: 'not_personal_dm_jid' };
  }
  // Defense-in-depth: never auto-register the bot's own JID, even if some
  // exotic Baileys event slipped past the channel-side fromMe filter.
  const botPhoneJid = getBotPhoneJid();
  if (botPhoneJid && chatJid === botPhoneJid) {
    logger.warn(
      { chatJid, botPhoneJid },
      'open-mode: refusing to onboard bot-self JID',
    );
    return { eligible: false, reason: 'bot_self_jid' };
  }
  if (openMode.dailyBudgetCents == null) {
    logger.warn(
      { chatJid },
      'open-mode: refusing to onboard (dailyBudgetCents not set — fail-closed)',
    );
    return { eligible: false, reason: 'budget_not_configured' };
  }

  const slug = jidToFolderSlug(chatJid);
  if (!slug) {
    logger.warn({ chatJid }, 'open-mode: cannot derive folder slug, skipping');
    return { eligible: false, reason: 'invalid_slug' };
  }
  const group: RegisteredGroup = {
    name: `Open DM ${slug}`,
    folder: `whatsapp_open-dm-${slug}`,
    trigger: '',
    added_at: new Date().toISOString(),
    requiresTrigger: false,
    isMain: false,
    containerConfig: {
      agentProfile: 'open_dm',
      // Default open_dm sessions to Haiku — cheap pattern execution, fits
      // the narrowed-tool stranger-facing profile. Operator can override
      // per-group later. Phase 0 of T-1777809840000.
      model: 'claude-haiku-4-5-20251001',
      // No additionalMounts — Brain stays absent. Even if added later,
      // container-runner's host-side filter strips brain/global for open_dm.
    },
  };
  return { eligible: true, group, reason: 'eligible' };
}

/**
 * Returns true if today's accumulated open_dm spend has hit or exceeded
 * the configured daily budget. Caller should drop the message silently
 * (no canned reply — revealing the cap to a flooder gives feedback,
 * and an outbound costs additional money).
 */
export function isOverBudget(openMode: OpenModeConfig): boolean {
  if (openMode.dailyBudgetCents == null) return true; // fail-closed
  const today = getOpenSpendForDate(todayUtcDate());
  return today.est_cost_cents >= openMode.dailyBudgetCents;
}

/**
 * Record an open_dm container spawn against today's budget. Call this
 * AFTER deciding to spawn (not after the spawn completes) so concurrent
 * spawns are accounted for promptly.
 */
export function recordSpawnSpend(openMode: OpenModeConfig): void {
  const cents =
    openMode.estCostCentsPerInvocation ?? DEFAULT_EST_COST_CENTS_PER_INVOCATION;
  recordOpenSpend(todayUtcDate(), cents);
}
