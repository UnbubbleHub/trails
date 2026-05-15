import type { Locale } from '@/i18n/config';
import type { TopicQueryLanguage } from '@/lib/repo/types';

/**
 * One persisted item in the agent's conversation history. Mirrors the OpenAI
 * Responses API input shape so we can pass `messages.map(toResponsesInput)`
 * straight into the next call.
 *
 * We persist function_call and function_call_output items separately so a
 * model that emits multiple tool calls in one turn replays correctly.
 */
export type AgentMessage =
  | { type: 'user_message'; content: string }
  | { type: 'assistant_message'; content: string }
  | { type: 'function_call'; call_id: string; name: string; arguments: string }
  | { type: 'function_call_output'; call_id: string; output: string };

/** A source suggestion as it travels through the agent. */
export interface ProposedSource {
  domain: string;
  name: string;
  /** Free-form rationale from the LLM. Telemetry/debug only. */
  why: string;
}

/** A preview sample item — light normalization of an Exa search result. */
export interface PreviewSampleItem {
  url: string;
  title: string;
  domain: string | null;
  publishedAt: string | null;
  /** Pre-formatted locale-aware relative date string ("today", "2 days ago", etc.). */
  relativeDate: string;
  snippet: string;
}

/**
 * Structured state accumulated across the conversation. Tools write to it as
 * a side effect when they produce results the model will want to consume on
 * later turns (e.g. the preview sample).
 */
export interface TrailDraft {
  description?: string;
  topicTitle?: string;
  filterRubric?: string;
  /** Cached spec derived once per description. Re-derived if description changes. */
  searchQuery?: string;
  queryLanguage?: TopicQueryLanguage;
  /** Domain → metadata. Kept as a list to preserve order. */
  sources?: ProposedSource[];
  /** Most recent preview run. Cleared if sources/description change. */
  preview?: {
    sample: PreviewSampleItem[];
    matchCount: number;
    frequencyPerWeek: number;
    /** Hash of description+sources at preview time. Used to invalidate stale samples. */
    inputHash: string;
  };
}

/** Sentinel emitted by the model to attach a "Confirm" button to its reply. */
export const CONFIRM_SENTINEL = '<confirm/>';

/** Turn caps — see system prompt. */
export const SOFT_TURN_CAP = 20;
export const HARD_TURN_CAP = 25;

/** Per-user Exa preview cap, rolling 1h window. */
export const EXA_CALLS_PER_HOUR_CAP = 10;

/** Bot tier identifier so storage keys don't collide across bots in the same Firestore project. */
export type AgentTier = 'trails';

export interface AgentTurnContext {
  chatId: number;
  telegramUserId: number;
  locale: Locale;
  editingSubscriptionId?: string;
}
