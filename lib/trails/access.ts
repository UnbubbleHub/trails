/**
 * Authorization gate based on the `TRAILS_ALLOWED_USER_IDS` env var.
 *
 * Values:
 *   - unset or empty → no one (default closed)
 *   - "*"            → everyone
 *   - "123,456,789"  → comma-separated Telegram numeric user IDs
 */
export function isUserAuthorized(telegramUserId: number): boolean {
  const raw = process.env.TRAILS_ALLOWED_USER_IDS?.trim();
  if (!raw) return false;
  if (raw === '*') return true;
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .includes(String(telegramUserId));
}
