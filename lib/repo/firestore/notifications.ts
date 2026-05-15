/**
 * Firestore implementation of `NotificationRepo`. Verbatim port of the
 * original `lib/db/topic-notification.ts` create/read logic. `hashUrl` is a
 * pure util and now lives in `@/lib/trails/hash-url`.
 */
import { randomBytes } from 'crypto';
import type {
  TopicNotificationInput,
  TopicNotificationRecord,
} from '@/lib/repo/types';
import type { NotificationRepo } from '@/lib/repo/index';
import {
  db,
  fromFs,
  NOTIFICATIONS_COLLECTION,
  toTs,
  withRetry,
} from './primitives';

function nid(): string {
  return randomBytes(10).toString('hex');
}

export const firestoreNotifications: NotificationRepo = {
  async create(input: TopicNotificationInput): Promise<string> {
    const id = nid();
    await withRetry(
      () =>
        db
          .collection(NOTIFICATIONS_COLLECTION)
          .doc(id)
          .set({
            subscriptionId: input.subscriptionId,
            telegramUserId: input.telegramUserId,
            searchResultId: input.searchResultId,
            url: input.url,
            urlHash: input.urlHash,
            title: input.title,
            headline: input.headline,
            summary: input.summary,
            publishedAt: input.publishedAt ? toTs(input.publishedAt) : null,
            sentAt: toTs(input.sentAt),
            telegramMessageId: input.telegramMessageId,
            coverImageUrl: input.coverImageUrl,
          }),
      { context: `notifications.create(${id})` }
    );
    return id;
  },

  /** Get the most recent notifications for a subscription, newest first. */
  async getRecent(
    subscriptionId: string,
    limit: number = 25
  ): Promise<TopicNotificationRecord[]> {
    const snap = await db
      .collection(NOTIFICATIONS_COLLECTION)
      .where('subscriptionId', '==', subscriptionId)
      .orderBy('sentAt', 'desc')
      .limit(limit)
      .get();

    return snap.docs.map((d) =>
      fromFs<TopicNotificationRecord>({ id: d.id, ...d.data() })
    );
  },
};
