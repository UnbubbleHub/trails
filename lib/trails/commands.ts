import { randomBytes } from 'crypto';
import { getTranslations } from 'next-intl/server';
import { type Locale } from '@/i18n/config';
import { getRepo } from '@/lib/repo';
import type { TopicConversationState, TopicSubscriptionRecord } from '@/lib/repo/types';
import { runAgentTurn, type AgentState } from './agent/runner';
import { trailsBot } from './bot-api';
import { renderManageListMessage } from './manage';

function newConversationId(): string {
  return randomBytes(10).toString('hex');
}

const TRAIL_CAP = 10;

const boldMarkup = {
  b: (chunks: string) => `<b>${chunks}</b>`,
} as const;

// ============================================================================
// Static commands
// ============================================================================

export async function handleStart(args: { chatId: number; locale: Locale }): Promise<void> {
  const t = await getTranslations({ locale: args.locale, namespace: 'trails' });
  await trailsBot().sendMessage(args.chatId, t.markup('welcome', boldMarkup), {
    parseMode: 'HTML',
    disableWebPagePreview: true,
  });
}

export async function handleHelp(args: { chatId: number; locale: Locale }): Promise<void> {
  const t = await getTranslations({ locale: args.locale, namespace: 'trails' });
  await trailsBot().sendMessage(args.chatId, t.markup('help', boldMarkup), {
    parseMode: 'HTML',
    disableWebPagePreview: true,
  });
}

export async function handleCancel(args: {
  chatId: number;
  telegramUserId: number;
  locale: Locale;
}): Promise<void> {
  const t = await getTranslations({ locale: args.locale, namespace: 'trails' });
  await getRepo().conversations.clear(args.chatId, args.telegramUserId, args.locale);
  await trailsBot().sendMessage(args.chatId, t('cancelled'));
}

export async function handleTrailsCommand(args: {
  chatId: number;
  telegramUserId: number;
  locale: Locale;
}): Promise<void> {
  await getRepo().conversations.clear(args.chatId, args.telegramUserId, args.locale);
  await renderManageListMessage({
    chatId: args.chatId,
    telegramUserId: args.telegramUserId,
    locale: args.locale,
  });
}

// ============================================================================
// /new — open the agent conversation
// ============================================================================

export async function handleNewCommand(args: {
  chatId: number;
  telegramUserId: number;
  locale: Locale;
  /** Optional text supplied after `/new` — treated as the first user message. */
  description?: string;
}): Promise<void> {
  const t = await getTranslations({ locale: args.locale, namespace: 'trails' });

  // Cap check up front so a user above the cap doesn't burn a placeholder turn.
  const subCount = await getRepo().subscriptions.countByUser(args.telegramUserId);
  if (subCount >= TRAIL_CAP) {
    await trailsBot().sendMessage(args.chatId, t('new.capReached', { cap: TRAIL_CAP }), {
      parseMode: 'HTML',
    });
    return;
  }

  const initialState: TopicConversationState = {
    type: 'creating_trail',
    conversationId: newConversationId(),
    messages: [],
    draft: {},
  };
  await getRepo().conversations.set(args.chatId, args.telegramUserId, args.locale, initialState);

  const opener = (args.description ?? '').trim();
  if (opener.length === 0) {
    // No initial description — send a fixed welcome and wait for the user's first message.
    await trailsBot().sendMessage(
      args.chatId,
      t.markup('create.opener', { i: (chunks) => `<i>${chunks}</i>` }),
      { parseMode: 'HTML', disableWebPagePreview: true }
    );
    return;
  }

  // Initial description provided — run the first agent turn immediately.
  await driveAgent({
    chatId: args.chatId,
    telegramUserId: args.telegramUserId,
    locale: args.locale,
    userInput: opener,
  });
}

/** Tap on the "Edit" button in the manage detail. Opens the agent seeded with the trail. */
export async function handleEditTrail(args: {
  chatId: number;
  telegramUserId: number;
  locale: Locale;
  subscription: TopicSubscriptionRecord;
}): Promise<void> {
  const t = await getTranslations({ locale: args.locale, namespace: 'trails' });

  const initialState: TopicConversationState = {
    type: 'creating_trail',
    conversationId: newConversationId(),
    messages: [],
    draft: {
      description: args.subscription.topicDescription,
      topicTitle: args.subscription.topicTitle,
      filterRubric: args.subscription.filterRubric ?? '',
      searchQuery: args.subscription.searchQuery,
      queryLanguage: args.subscription.queryLanguage,
      sources: (args.subscription.includeDomains ?? []).map((d) => ({
        domain: d,
        name: d,
        why: '',
      })),
    },
    editingSubscriptionId: args.subscription.id,
  };
  await getRepo().conversations.set(args.chatId, args.telegramUserId, args.locale, initialState);

  // Send a brief opener, then let the agent run with a synthetic kickoff.
  await trailsBot().sendMessage(
    args.chatId,
    t.markup('create.editOpener', {
      title: escapeHtml(args.subscription.topicTitle),
      ...boldMarkup,
    }),
    { parseMode: 'HTML', disableWebPagePreview: true }
  );
}

// ============================================================================
// Agent turn driver — used by dispatcher for text + Confirm callbacks
// ============================================================================

/**
 * Load conversation state and run one agent turn. Persists the result. Returns
 * silently if the conversation isn't in `creating_trail` (the dispatcher
 * already handled commands before reaching us).
 */
export async function driveAgent(args: {
  chatId: number;
  telegramUserId: number;
  locale: Locale;
  userInput: string;
}): Promise<void> {
  const repo = getRepo();
  const conv = await repo.conversations.get(args.chatId);
  if (conv.state.type !== 'creating_trail') return;

  const state: AgentState = {
    conversationId: conv.state.conversationId,
    messages: conv.state.messages,
    draft: conv.state.draft,
    ...(conv.state.placeholderMessageId !== undefined && {
      placeholderMessageId: conv.state.placeholderMessageId,
    }),
    ...(conv.state.editingSubscriptionId && {
      editingSubscriptionId: conv.state.editingSubscriptionId,
    }),
  };

  // Eagerly load the subscription record when editing, so the system prompt
  // can summarize the current trail.
  if (conv.state.editingSubscriptionId && !state.editingSubscription) {
    const sub = await repo.subscriptions.getById(conv.state.editingSubscriptionId);
    if (sub) state.editingSubscription = sub;
  }

  const result = await runAgentTurn({
    ctx: {
      chatId: args.chatId,
      telegramUserId: args.telegramUserId,
      locale: args.locale,
      ...(state.editingSubscriptionId && { editingSubscriptionId: state.editingSubscriptionId }),
    },
    state,
    userInput: args.userInput,
  });

  if (result.status === 'finalized') {
    await repo.conversations.clear(args.chatId, args.telegramUserId, args.locale);
    return;
  }

  const newState: TopicConversationState = {
    type: 'creating_trail',
    conversationId: result.state.conversationId,
    messages: result.state.messages,
    draft: result.state.draft,
    ...(result.state.placeholderMessageId !== undefined && {
      placeholderMessageId: result.state.placeholderMessageId,
    }),
    ...(result.state.editingSubscriptionId && {
      editingSubscriptionId: result.state.editingSubscriptionId,
    }),
  };
  await repo.conversations.set(args.chatId, args.telegramUserId, args.locale, newState);
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export { TRAIL_CAP };
