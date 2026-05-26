/**
 * Repository abstraction. All persistence in `lib/trails/*` goes through
 * `getRepo()` — never through a storage SDK directly. Firestore is the only
 * implementation today; another backend (Postgres, …) can be added by
 * implementing these interfaces and wiring a new branch in `getRepo()`,
 * without touching business logic.
 *
 * The hard storage behaviors are expressed as method *contracts*, not leaked
 * primitives:
 *   - `subscriptions.recordNotificationSent` MUST increment atomically.
 *   - `conversations.set` MUST preserve the Exa counter across state writes;
 *     `conversations.incrementExaCallCounter` MUST be an atomic rolling-1h
 *     window returning the post-increment count.
 *   - `conversations.get` MUST return an `idle` record when the doc is missing
 *     or its 15-min expiry has passed (lazy expiry; a backend may also enforce
 *     a storage-side TTL).
 */
import type {
  TopicConversationRecord,
  TopicConversationState,
  TopicNotificationInput,
  TopicNotificationRecord,
  TopicSubscriptionDraft,
  TopicSubscriptionRecord,
} from '@/lib/repo/types';
import type { Locale } from '@/i18n/config';
import { firestoreConversations } from './firestore/conversations';
import { firestoreNotifications } from './firestore/notifications';
import { firestoreSubscriptions } from './firestore/subscriptions';

export interface SubscriptionRepo {
  create(draft: TopicSubscriptionDraft): Promise<string>;
  getById(id: string): Promise<TopicSubscriptionRecord | null>;
  listByUser(telegramUserId: number): Promise<TopicSubscriptionRecord[]>;
  countByUser(telegramUserId: number): Promise<number>;
  listDue(now: Date, limit: number): Promise<TopicSubscriptionRecord[]>;
  updateDraft(id: string, draft: TopicSubscriptionDraft): Promise<void>;
  delete(id: string): Promise<void>;
  /** Bump counters after a send. `totalNotificationsSent` is atomic. */
  recordNotificationSent(id: string, now: Date): Promise<void>;
  /** Advance lastCheckedAt + nextCheckDue (~4h − 5min cadence). */
  markChecked(id: string, now: Date): Promise<void>;
}

export interface ConversationRepo {
  /** Missing or expired → an (unpersisted) idle record. */
  get(chatId: number): Promise<TopicConversationRecord>;
  /** Persist state; preserves the Exa counter. */
  set(
    chatId: number,
    telegramUserId: number,
    locale: Locale,
    state: TopicConversationState
  ): Promise<void>;
  /** Atomic rolling-1h-window increment; returns the post-increment count. */
  incrementExaCallCounter(chatId: number, telegramUserId: number, locale: Locale): Promise<number>;
  clear(chatId: number, telegramUserId: number, locale: Locale): Promise<void>;
}

export interface NotificationRepo {
  create(input: TopicNotificationInput): Promise<string>;
  getRecent(subscriptionId: string, limit?: number): Promise<TopicNotificationRecord[]>;
}

export interface Repo {
  subscriptions: SubscriptionRepo;
  conversations: ConversationRepo;
  notifications: NotificationRepo;
}

function createFirestoreRepo(): Repo {
  return {
    subscriptions: firestoreSubscriptions,
    conversations: firestoreConversations,
    notifications: firestoreNotifications,
  };
}

let _repo: Repo | null = null;

export function getRepo(): Repo {
  if (_repo) return _repo;
  const backend = process.env.TRAILS_REPO_BACKEND ?? 'firestore';
  if (backend !== 'firestore') {
    throw new Error(`Unknown TRAILS_REPO_BACKEND: ${backend}`);
  }
  _repo = createFirestoreRepo();
  return _repo;
}

// Pure id helpers — backend-agnostic, re-exported for convenience.
export { buildSubscriptionId, parseSubscriptionId, suffixOfSubscriptionId } from '@/lib/repo/ids';
