/**
 * Pure subscription-id helpers. Backend-agnostic — no storage imports.
 *
 * A subscription id is `${telegramUserId}_${shortId(8)}`. The short suffix is
 * what travels in Telegram callback_data (which has a 64-byte budget); the full
 * id is reconstructed from the suffix + the user id of the tapping user.
 */
import { randomBytes } from 'crypto';

const ID_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';

/** Short id generator (alphanumeric, no ambiguous chars). ~2^47 at len=8. */
function shortId(len: number = 8): string {
  const bytes = randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) {
    out += ID_ALPHABET[bytes[i] % ID_ALPHABET.length];
  }
  return out;
}

export function buildSubscriptionId(telegramUserId: number): string {
  return `${telegramUserId}_${shortId(8)}`;
}

export function parseSubscriptionId(suffix: string, telegramUserId: number): string {
  return `${telegramUserId}_${suffix}`;
}

export function suffixOfSubscriptionId(subscriptionId: string): string {
  const idx = subscriptionId.indexOf('_');
  return idx >= 0 ? subscriptionId.slice(idx + 1) : subscriptionId;
}
