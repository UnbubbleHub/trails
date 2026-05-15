/**
 * Persistence-facing domain types, decoupled from any storage backend.
 * Dates are plain `Date` (backends convert to/from their own representation).
 */
import type { Locale } from '@/i18n/config';
import type { AgentMessage, TrailDraft } from '@/lib/trails/agent/types';

// ============================================================================
// Subscriptions
// ============================================================================

export type TopicQueryLanguage = 'en' | 'source';

/** Persisted record for a user's topic subscription. */
export interface TopicSubscriptionRecord {
  id: string;
  telegramUserId: number;
  telegramChatId: number;
  /** Always `null` in this standalone build (kept for schema stability). */
  email: string | null;
  locale: Locale;
  /** Short LLM-derived label for lists & UI. */
  topicTitle: string;
  /** Raw user prompt — what the user typed to describe the topic. */
  topicDescription: string;
  /**
   * Structured filter rubric (plaintext bullet checklist) used by downstream
   * LLMs to judge whether a candidate news article matches the topic. Optional
   * for backwards compatibility — older subscriptions written before this
   * field existed will be missing it; downstream prompts fall back to
   * `topicDescription` alone in that case.
   */
  filterRubric?: string;
  /** LLM-encoded query string passed to the news search provider. */
  searchQuery: string;
  includeDomains: string[] | null;
  excludeDomains: string[] | null;
  queryLanguage: TopicQueryLanguage;
  createdAt: Date;
  updatedAt: Date;
  /** Last time the cron successfully ran a search for this sub. */
  lastCheckedAt: Date;
  /** Next time the cron should check (~4h after lastCheckedAt). */
  nextCheckDue: Date;
  lastNotifiedAt: Date | null;
  totalNotificationsSent: number;
}

/** Snapshot used while the preview is pending confirmation. */
export interface TopicSubscriptionDraft {
  telegramUserId: number;
  telegramChatId: number;
  email: string | null;
  locale: Locale;
  topicTitle: string;
  topicDescription: string;
  /** Plaintext bullet checklist (see `TopicSubscriptionRecord.filterRubric`). Empty string allowed when generation produced nothing. */
  filterRubric: string;
  searchQuery: string;
  includeDomains: string[] | null;
  excludeDomains: string[] | null;
  queryLanguage: TopicQueryLanguage;
}

// ============================================================================
// Conversations
// ============================================================================

export type TopicConversationState =
  | { type: 'idle' }
  | {
      type: 'creating_trail';
      /** Random id stamped on every model call in this conversation. */
      conversationId: string;
      /** Conversation log fed to the agent each turn. */
      messages: AgentMessage[];
      /** Accumulated structured state (description, sources, last preview, etc.). */
      draft: TrailDraft;
      /** Telegram message id of the current placeholder bubble, used to attach Confirm/Manage buttons. */
      placeholderMessageId?: number;
      /** When set, finalize_trail updates this subscription instead of creating a new one. */
      editingSubscriptionId?: string;
    };

export interface TopicConversationRecord {
  telegramChatId: number;
  telegramUserId: number;
  locale: Locale;
  state: TopicConversationState;
  /** Per-hour Exa preview counter. Used to rate-limit run_preview. */
  exaCallsThisHour: number;
  exaCallsWindowStart: Date;
  updatedAt: Date;
  /** Conversation expiry (15 min). Backends may also enforce this as a TTL. */
  expiresAt: Date;
}

// ============================================================================
// Notifications
// ============================================================================

export interface TopicNotificationRecord {
  id: string;
  subscriptionId: string;
  telegramUserId: number;
  /** Search-provider result id. Null if synthesized. */
  searchResultId: string | null;
  url: string;
  urlHash: string;
  title: string;
  headline: string;
  summary: string;
  publishedAt: Date | null;
  sentAt: Date;
  telegramMessageId: number | null;
  coverImageUrl: string | null;
}

export interface TopicNotificationInput {
  subscriptionId: string;
  telegramUserId: number;
  searchResultId: string | null;
  url: string;
  urlHash: string;
  title: string;
  headline: string;
  summary: string;
  publishedAt: Date | null;
  sentAt: Date;
  telegramMessageId: number | null;
  coverImageUrl: string | null;
}
