/**
 * Callback-data encoding for inline-keyboard taps.
 *
 * Format: `v1:<action>:<arg>` — ASCII, always ≤ 64 bytes (Telegram's limit).
 * Actions are 2-3 letter codes. `arg` is either a subscription id suffix (the
 * nanoid part after the `_`), a locale code (for `lg`), or a placeholder `-`.
 *
 * Why not include the full subscription id? Telegram leaks callback_data to
 * anyone inspecting the message. Carrying only the suffix and composing the
 * full id at dispatch time using `callback_query.from.id` also blocks
 * cross-user tampering: a tap from user X on a button carrying user Y's
 * suffix resolves to a subscription id that doesn't exist or doesn't belong
 * to user X, and the dispatcher rejects it.
 */

export type CallbackAction =
  | 'tc' // trails create: confirm (synthetic "Confirm." injected into the agent)
  | 'mg' // manage (open list from a notification)
  | 'sp' // stop this topic (from a notification) — first tap
  | 'spc' // stop this topic — confirm
  | 'lo' // list: open the detail view for a topic (arg = subscription id suffix)
  | 'lpg' // list: change page (arg = page index, 0-based)
  | 'lE' // list: edit trail (opens agent conversation seeded with the trail)
  | 'ld' // list: delete — first tap
  | 'ldc' // list: delete — confirm
  | 'nn' // new (from list): start a /new flow
  | 'bk' // go back to list
  | 'lg'; // /language: pick a locale (arg = locale code, e.g. 'it')

export interface CallbackPayload {
  action: CallbackAction;
  /** A short random token (for previews) or a subscription-id suffix. */
  arg: string;
}

export function encodeCallback(payload: CallbackPayload): string {
  const s = `v1:${payload.action}:${payload.arg}`;
  if (Buffer.byteLength(s, 'utf8') > 64) {
    throw new Error(`Callback payload too large (${s.length} bytes): ${s}`);
  }
  return s;
}

export function decodeCallback(raw: string | undefined): CallbackPayload | null {
  if (!raw) return null;
  const parts = raw.split(':');
  if (parts.length < 3) return null;
  if (parts[0] !== 'v1') return null;
  const action = parts[1] as CallbackAction;
  const arg = parts.slice(2).join(':');
  const allowed: CallbackAction[] = [
    'tc',
    'mg',
    'sp',
    'spc',
    'lo',
    'lpg',
    'lE',
    'ld',
    'ldc',
    'nn',
    'bk',
    'lg',
  ];
  if (!allowed.includes(action)) return null;
  return { action, arg };
}
