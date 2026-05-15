/**
 * Firestore implementation of `ConversationRepo`. Verbatim port of the
 * original `lib/db/topic-conversation.ts` — including the transaction that
 * preserves the Exa counter across state writes, the atomic windowed counter
 * increment, and the lazy 15-min expiry check on read.
 */
import type { Locale } from '@/i18n/config';
import type {
  TopicConversationRecord,
  TopicConversationState,
} from '@/lib/repo/types';
import type { ConversationRepo } from '@/lib/repo/index';
import {
  CONVERSATIONS_COLLECTION,
  db,
  fromFs,
  runTx,
  serverTs,
  Timestamp,
  toTs,
  withRetry,
} from './primitives';

const TTL_MS = 15 * 60 * 1000; // 15 min
const EXA_WINDOW_MS = 60 * 60 * 1000; // 1 hour

function emptyConversation(chatId: number, now: Date): TopicConversationRecord {
  return {
    telegramChatId: chatId,
    telegramUserId: 0,
    locale: 'en',
    state: { type: 'idle' },
    exaCallsThisHour: 0,
    exaCallsWindowStart: now,
    updatedAt: now,
    expiresAt: new Date(now.getTime() + TTL_MS),
  };
}

export const firestoreConversations: ConversationRepo = {
  /**
   * Look up conversation state for a chat. Returns an `idle` record (not
   * persisted) if there is no doc or the 15-min expiry has passed.
   */
  async get(chatId: number): Promise<TopicConversationRecord> {
    const snap = await db.collection(CONVERSATIONS_COLLECTION).doc(String(chatId)).get();

    const now = new Date();
    if (!snap.exists) {
      return emptyConversation(chatId, now);
    }
    const record = fromFs<TopicConversationRecord>({
      ...snap.data(),
      telegramChatId: chatId,
    });
    if (record.expiresAt.getTime() < now.getTime()) {
      return { ...record, state: { type: 'idle' } };
    }
    // Backwards compat: old docs may not carry the new state shape — coerce to idle.
    if (record.state && record.state.type !== 'idle' && record.state.type !== 'creating_trail') {
      return { ...record, state: { type: 'idle' } };
    }
    return record;
  },

  /** Persist a new state for this chat's conversation. */
  async set(
    chatId: number,
    telegramUserId: number,
    locale: Locale,
    state: TopicConversationState
  ): Promise<void> {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + TTL_MS);

    // No `merge: true`: Firestore deep-merges nested maps, which would let
    // sub-fields of a previous `state` bleed across transitions. We write all
    // top-level fields the doc cares about explicitly. The Exa counter is
    // preserved by reading it inside the transaction.
    const ref = db.collection(CONVERSATIONS_COLLECTION).doc(String(chatId));
    await withRetry(
      () =>
        runTx(async (tx) => {
          const snap = await tx.get(ref);
          const data = snap.data();
          const windowStart =
            (data?.exaCallsWindowStart as Timestamp | undefined)?.toDate() ?? now;
          const count = (data?.exaCallsThisHour as number | undefined) ?? 0;

          const doc: Record<string, unknown> = {
            telegramUserId,
            locale,
            state,
            exaCallsThisHour: count,
            exaCallsWindowStart: toTs(windowStart),
            updatedAt: serverTs(),
            expiresAt: toTs(expiresAt),
          };
          tx.set(ref, doc);
        }),
      { context: `conversations.set(${chatId})` }
    );
  },

  /**
   * Atomically increment the per-hour Exa preview counter for rate limiting.
   * Rolls the window if >1h has passed since the current window's start.
   * Returns the post-increment count.
   */
  async incrementExaCallCounter(
    chatId: number,
    telegramUserId: number,
    locale: Locale
  ): Promise<number> {
    const ref = db.collection(CONVERSATIONS_COLLECTION).doc(String(chatId));
    const now = new Date();
    const expiresAt = new Date(now.getTime() + TTL_MS);

    return await withRetry(
      () =>
        runTx(async (tx) => {
          const snap = await tx.get(ref);
          const data = snap.data();
          const windowStart =
            (data?.exaCallsWindowStart as Timestamp | undefined)?.toDate() ?? null;
          const count = (data?.exaCallsThisHour as number | undefined) ?? 0;

          let nextCount = count + 1;
          let nextWindowStart = windowStart ?? now;
          if (!windowStart || now.getTime() - windowStart.getTime() > EXA_WINDOW_MS) {
            nextCount = 1;
            nextWindowStart = now;
          }

          const update: Record<string, unknown> = {
            telegramUserId,
            locale,
            exaCallsThisHour: nextCount,
            exaCallsWindowStart: toTs(nextWindowStart),
            updatedAt: serverTs(),
            expiresAt: toTs(expiresAt),
          };
          if (!snap.exists) {
            update.state = { type: 'idle' };
          }

          tx.set(ref, update, { merge: true });
          return nextCount;
        }),
      { context: `conversations.incrementExaCallCounter(${chatId})` }
    );
  },

  /** Clear conversation state for a chat (set to idle). */
  async clear(chatId: number, telegramUserId: number, locale: Locale): Promise<void> {
    await this.set(chatId, telegramUserId, locale, { type: 'idle' });
  },
};
