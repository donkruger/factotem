/**
 * Per-sender token-bucket rate limiter for open_dm mode.
 * SQLite-backed via open_rate_buckets so state survives NanoClaw restarts.
 */

import { getOpenRateBucket, setOpenRateBucket } from './db.js';
import { logger } from './logger.js';
import { OpenModeRateLimit } from './types.js';

export interface ConsumeResult {
  allowed: boolean;
  retryAfterSec: number;
}

/**
 * Try to consume one token from the sender's bucket. Returns whether the
 * request is allowed and, if not, how many seconds until one token is
 * available again.
 *
 * Token bucket (not sliding window): tolerates first-contact bursts like
 * "hi" / "sorry, ignore that" / "I meant…" while still capping sustained rate.
 */
export function consume(
  senderJid: string,
  limit: OpenModeRateLimit,
): ConsumeResult {
  const tokensPerHour = Math.max(0, limit.tokensPerHour);
  const burstMax = Math.max(1, limit.burstMax);
  const tokensPerMs = tokensPerHour / 3_600_000;
  const now = Date.now();
  const nowIso = new Date(now).toISOString();

  const existing = getOpenRateBucket(senderJid);
  let tokens: number;
  if (!existing) {
    tokens = burstMax;
  } else {
    const lastMs = Date.parse(existing.last_refill);
    const elapsed = Math.max(0, now - lastMs);
    tokens = Math.min(burstMax, existing.tokens + elapsed * tokensPerMs);
  }

  if (tokens >= 1) {
    setOpenRateBucket({
      sender_jid: senderJid,
      tokens: tokens - 1,
      last_refill: nowIso,
    });
    return { allowed: true, retryAfterSec: 0 };
  }

  // Deny — persist the refilled (sub-1) token count so refill clock keeps moving.
  setOpenRateBucket({
    sender_jid: senderJid,
    tokens,
    last_refill: nowIso,
  });
  const needed = 1 - tokens;
  const retryAfterSec =
    tokensPerMs > 0 ? Math.ceil(needed / (tokensPerMs * 1000)) : 3600;
  logger.debug({ senderJid, tokens, retryAfterSec }, 'open-rate-limit: denied');
  return { allowed: false, retryAfterSec };
}
