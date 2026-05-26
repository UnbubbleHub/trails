/**
 * Firestore implementation of `SubscriptionRepo`. Verbatim port of the
 * original `lib/db/topic-subscription.ts` logic — only the storage primitives
 * are funneled through `./primitives` and the collection is `trails-*`.
 */
import { buildSubscriptionId } from '@/lib/repo/ids';
import type { TopicSubscriptionDraft, TopicSubscriptionRecord } from '@/lib/repo/types';
import type { SubscriptionRepo } from '@/lib/repo/index';
import {
  db,
  fromFs,
  incr,
  serverTs,
  SUBSCRIPTIONS_COLLECTION,
  Timestamp,
  toTs,
  withRetry,
} from './primitives';

export const firestoreSubscriptions: SubscriptionRepo = {
  /** Create a new subscription from a preview draft. Returns the new id. */
  async create(draft: TopicSubscriptionDraft): Promise<string> {
    const id = buildSubscriptionId(draft.telegramUserId);
    const now = new Date();

    const doc = {
      telegramUserId: draft.telegramUserId,
      telegramChatId: draft.telegramChatId,
      email: draft.email,
      locale: draft.locale,
      topicTitle: draft.topicTitle,
      topicDescription: draft.topicDescription,
      filterRubric: draft.filterRubric,
      searchQuery: draft.searchQuery,
      includeDomains: draft.includeDomains,
      excludeDomains: draft.excludeDomains,
      queryLanguage: draft.queryLanguage,
      createdAt: serverTs(),
      updatedAt: serverTs(),
      lastCheckedAt: toTs(now),
      nextCheckDue: toTs(now),
      lastNotifiedAt: null,
      totalNotificationsSent: 0,
    };

    await withRetry(() => db.collection(SUBSCRIPTIONS_COLLECTION).doc(id).set(doc), {
      context: `subscriptions.create(${id})`,
    });

    return id;
  },

  /** Fetch a single subscription by id. Returns null if missing. */
  async getById(id: string): Promise<TopicSubscriptionRecord | null> {
    const snap = await db.collection(SUBSCRIPTIONS_COLLECTION).doc(id).get();
    if (!snap.exists) return null;
    return fromFs<TopicSubscriptionRecord>({ id: snap.id, ...snap.data() });
  },

  /** List all subs for a user, newest first. */
  async listByUser(telegramUserId: number): Promise<TopicSubscriptionRecord[]> {
    const snap = await db
      .collection(SUBSCRIPTIONS_COLLECTION)
      .where('telegramUserId', '==', telegramUserId)
      .orderBy('createdAt', 'desc')
      .get();

    return snap.docs.map((d) => fromFs<TopicSubscriptionRecord>({ id: d.id, ...d.data() }));
  },

  /** Count subscriptions for a user. Used for the per-user cap. */
  async countByUser(telegramUserId: number): Promise<number> {
    const snap = await db
      .collection(SUBSCRIPTIONS_COLLECTION)
      .where('telegramUserId', '==', telegramUserId)
      .count()
      .get();
    return snap.data().count;
  },

  /** Find subs whose `nextCheckDue` is at or before `now`. Used by cron. */
  async listDue(now: Date, limit: number): Promise<TopicSubscriptionRecord[]> {
    const snap = await db
      .collection(SUBSCRIPTIONS_COLLECTION)
      .where('nextCheckDue', '<=', toTs(now))
      .orderBy('nextCheckDue', 'asc')
      .limit(limit)
      .get();

    return snap.docs.map((d) => fromFs<TopicSubscriptionRecord>({ id: d.id, ...d.data() }));
  },

  /** Edit a subscription in place: replaces prompt + derived query fields. */
  async updateDraft(id: string, draft: TopicSubscriptionDraft): Promise<void> {
    await withRetry(
      () =>
        db.collection(SUBSCRIPTIONS_COLLECTION).doc(id).update({
          topicTitle: draft.topicTitle,
          topicDescription: draft.topicDescription,
          filterRubric: draft.filterRubric,
          searchQuery: draft.searchQuery,
          includeDomains: draft.includeDomains,
          excludeDomains: draft.excludeDomains,
          queryLanguage: draft.queryLanguage,
          locale: draft.locale,
          updatedAt: serverTs(),
        }),
      { context: `subscriptions.updateDraft(${id})` }
    );
  },

  async delete(id: string): Promise<void> {
    await withRetry(() => db.collection(SUBSCRIPTIONS_COLLECTION).doc(id).delete(), {
      context: `subscriptions.delete(${id})`,
    });
  },

  /**
   * Bump counters after a successful notification send.
   * `totalNotificationsSent` MUST be an atomic increment (concurrent cron
   * workers may touch the same sub).
   */
  async recordNotificationSent(id: string, now: Date): Promise<void> {
    await withRetry(
      () =>
        db
          .collection(SUBSCRIPTIONS_COLLECTION)
          .doc(id)
          .update({
            totalNotificationsSent: incr(1),
            lastNotifiedAt: toTs(now),
            updatedAt: serverTs(),
          }),
      { context: `subscriptions.recordNotificationSent(${id})` }
    );
  },

  /**
   * Mark a cron pass complete. Bumps `lastCheckedAt` + `nextCheckDue` to the
   * next 4-hour tick, minus a 5-minute jitter buffer.
   *
   * Why the buffer: a cron fires at the top of the scheduled hour but actually
   * invokes the function a few seconds later. If we set
   * `nextCheckDue = now + 4h` exactly, the next 4h tick at 06:00:00.000 might
   * see a sub due at 06:00:03.456 and skip it — collapsing cadence to 8h.
   * Subtracting 5 min ensures the sub is past-due by the time the next tick
   * fires, regardless of where in the cron-jitter window we landed.
   */
  async markChecked(id: string, now: Date): Promise<void> {
    const next = new Date(now.getTime() + (4 * 60 - 5) * 60 * 1000);
    await withRetry(
      () =>
        db
          .collection(SUBSCRIPTIONS_COLLECTION)
          .doc(id)
          .update({
            lastCheckedAt: toTs(now),
            nextCheckDue: toTs(next),
            updatedAt: serverTs(),
          }),
      { context: `subscriptions.markChecked(${id})` }
    );
  },
};
