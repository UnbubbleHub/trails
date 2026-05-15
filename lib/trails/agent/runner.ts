import { getTranslations } from 'next-intl/server';
import OpenAI from 'openai';
import { openai } from '@/lib/ai/client';
import { getRepo } from '@/lib/repo';
import type { TopicSubscriptionRecord } from '@/lib/repo/types';
import { trailsBot } from '../bot-api';
import { encodeCallback } from '../callback-data';
import { MessageEditor } from './stream';
import { buildSystemPrompt } from './system-prompt';
import { executeTool, trailTools } from './tools';
import {
  CONFIRM_SENTINEL,
  HARD_TURN_CAP,
  SOFT_TURN_CAP,
  type AgentMessage,
  type AgentTurnContext,
  type TrailDraft,
} from './types';

const MODEL = 'gpt-5.4-mini' as const;
const SERVICE_TIER = 'auto' as const;
const REASONING_EFFORT = 'low' as const;
const MAX_TOOL_ITERATIONS = 6;

/** State passed in and out of the runner. */
export interface AgentState {
  /** Random id linking telemetry across turns. */
  conversationId: string;
  messages: AgentMessage[];
  draft: TrailDraft;
  placeholderMessageId?: number;
  editingSubscriptionId?: string;
  /** Cached subscription record when editing, so we can re-seed the system prompt. */
  editingSubscription?: TopicSubscriptionRecord;
}

export type AgentTurnResult =
  | { status: 'continue'; state: AgentState }
  | { status: 'finalized'; subscriptionId: string };

/**
 * Run one agent turn — append the user input, call the model, execute any tool
 * calls in a loop, stream assistant text into the placeholder, attach the
 * Confirm button if the model emitted the sentinel, and return the new state.
 *
 * Mutates `state` in place. The caller persists the returned state.
 */
export async function runAgentTurn(args: {
  ctx: AgentTurnContext;
  state: AgentState;
  /** Verbatim user message or synthetic 'Confirm.' for button taps. */
  userInput: string;
}): Promise<AgentTurnResult> {
  const { ctx, state } = args;

  // Append the inbound user message.
  state.messages.push({ type: 'user_message', content: args.userInput });

  // Enforce the hard turn cap before doing any work.
  const userTurnCount = state.messages.filter((m) => m.type === 'user_message').length;
  if (userTurnCount > HARD_TURN_CAP) {
    await trailsBot().sendMessage(ctx.chatId, await wrapsUpMessage(ctx), {
      parseMode: 'HTML',
      disableWebPagePreview: true,
    });
    return { status: 'continue', state };
  }

  // Soft-cap nudge: inject as a system reminder once on the first turn past the soft cap.
  if (
    userTurnCount === SOFT_TURN_CAP + 1 &&
    !state.messages.some(
      (m) => m.type === 'assistant_message' && m.content.includes('[soft_cap_nudge]')
    )
  ) {
    state.messages.push({
      type: 'assistant_message',
      content:
        '[soft_cap_nudge] (Internal: the user has been going for a while. Help them land on a final trail in the next couple of turns.)',
    });
  }

  // Send the placeholder bubble — a random Claude-Code-style status phrase
  // wrapped in a Telegram spoiler so it reads as ephemeral status, not content.
  const placeholderText = await randomLoadingPhrase(ctx);
  const placeholderId = await trailsBot().sendMessage(ctx.chatId, placeholderText, {
    parseMode: 'HTML',
    disableWebPagePreview: true,
  });
  if (placeholderId === undefined) {
    console.warn('[TrailsAgent] failed to send placeholder');
    return { status: 'continue', state };
  }
  state.placeholderMessageId = placeholderId;

  const editor = new MessageEditor({
    chatId: ctx.chatId,
    messageId: placeholderId,
    initialText: placeholderText,
  });

  // Build the system prompt fresh per turn (locale or editing context may have changed).
  const tPrompt = await getTranslations({ locale: ctx.locale, namespace: 'trails.create' });
  const systemPrompt = buildSystemPrompt({
    locale: ctx.locale,
    ...(state.editingSubscription && { editing: state.editingSubscription }),
    sourcesConfirmPrompt: tPrompt('sourcesConfirmPrompt'),
    previewConfirmPrompt: tPrompt('previewConfirmPrompt'),
    previewEmptyConfirmPrompt: tPrompt('previewEmptyConfirmPrompt'),
  });

  // Tool-call loop. Each iteration may produce new tool_calls; we execute them
  // and feed the outputs back into the next model call. Terminate when the
  // model returns text without tool calls, or when we hit MAX_TOOL_ITERATIONS.
  let assistantText = '';
  let finalizedSubscriptionId: string | null = null;
  let assistantTextHasContent = false;

  for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
    assistantText = '';
    assistantTextHasContent = false;
    const input = toResponsesInput({ systemPrompt, messages: state.messages });

    let stream: AsyncIterable<OpenAI.Responses.ResponseStreamEvent>;
    try {
      stream = await openai.responses.create({
        model: MODEL,
        service_tier: SERVICE_TIER,
        reasoning: { effort: REASONING_EFFORT, summary: 'concise' },
        input,
        tools: trailTools,
        stream: true,
      });
    } catch (err) {
      console.error('[TrailsAgent] responses.create failed:', err);
      await editor.finalize(await errorMessage(ctx));
      return { status: 'continue', state };
    }

    const pendingFunctionCalls: { call_id: string; name: string; arguments: string }[] = [];
    let completedResponse: OpenAI.Responses.Response | null = null;

    try {
      for await (const event of stream) {
        if (event.type === 'response.output_text.delta') {
          assistantText += event.delta;
          if (event.delta.length > 0) assistantTextHasContent = true;
          editor.update(toDisplayText(assistantText, placeholderText));
        } else if (event.type === 'response.output_item.done') {
          const item = event.item;
          if (item.type === 'function_call') {
            pendingFunctionCalls.push({
              call_id: item.call_id,
              name: item.name,
              arguments: item.arguments,
            });
          } else if (item.type === 'message') {
            // Capture the assistant text fully (in case streaming missed any).
            const text =
              item.content
                ?.map((c: { type: string; text?: string }) =>
                  c.type === 'output_text' && typeof c.text === 'string' ? c.text : ''
                )
                .join('') ?? '';
            if (text) {
              assistantText = text;
              assistantTextHasContent = true;
              editor.update(toDisplayText(assistantText, placeholderText));
            }
          }
        } else if (event.type === 'response.completed') {
          completedResponse = event.response;
        }
      }
    } catch (err) {
      console.error('[TrailsAgent] streaming failed:', err);
      await editor.finalize(await errorMessage(ctx));
      return { status: 'continue', state };
    }

    // Persist the assistant message (text portion).
    if (assistantTextHasContent) {
      state.messages.push({ type: 'assistant_message', content: assistantText });
    }

    // If the model emitted the confirm sentinel, the turn is done — wait for
    // the user. Any tool calls it queued in the same response (e.g. racing
    // ahead with run_preview before the user actually confirms the sources)
    // are dropped on the floor; otherwise the next iteration's edit would
    // overwrite the placeholder with the next step's message before the user
    // had a chance to tap Confirm.
    if (assistantText.includes(CONFIRM_SENTINEL)) {
      if (pendingFunctionCalls.length > 0) {
        console.warn(
          `[TrailsAgent] Discarding ${pendingFunctionCalls.length} tool call(s) emitted alongside <confirm/>; waiting for user.`
        );
      }
      break;
    }

    if (pendingFunctionCalls.length === 0) {
      // No more tool calls — we're done with this turn.
      break;
    }

    // Execute all tool calls sequentially. Append function_call + function_call_output to history.
    for (const call of pendingFunctionCalls) {
      state.messages.push({
        type: 'function_call',
        call_id: call.call_id,
        name: call.name,
        arguments: call.arguments,
      });

      const result = await executeTool({
        name: call.name,
        argsJson: call.arguments,
        ctx: {
          chatId: ctx.chatId,
          telegramUserId: ctx.telegramUserId,
          locale: ctx.locale,
          conversationId: state.conversationId,
          ...(ctx.editingSubscriptionId && { editingSubscriptionId: ctx.editingSubscriptionId }),
          draft: state.draft,
          incrementExaCounter: () =>
            getRepo().conversations.incrementExaCallCounter(
              ctx.chatId,
              ctx.telegramUserId,
              ctx.locale
            ),
        },
      });

      state.messages.push({
        type: 'function_call_output',
        call_id: call.call_id,
        output: JSON.stringify(result.output),
      });

      if (result.finalized) {
        finalizedSubscriptionId = result.finalized.subscriptionId;
      }
    }

    if (completedResponse === null) {
      // No completion event — bail.
      break;
    }
  }

  // Final assistant message rendering.
  const hasConfirm = assistantText.includes(CONFIRM_SENTINEL);
  const cleanText = stripConfirm(assistantText).trim();

  if (finalizedSubscriptionId) {
    // Delete the loading placeholder and send a fresh confirmation message
    // with a recap of the saved trail. Headline differs between create/edit;
    // we force the locale because the model tends to drift to English.
    const t = await getTranslations({ locale: ctx.locale, namespace: 'trails' });
    // Settle any pending streaming edits before deleting the placeholder,
    // so we don't race against an in-flight editMessageText.
    await editor.finalize();
    await trailsBot().deleteMessage(ctx.chatId, state.placeholderMessageId!);

    const headline = ctx.editingSubscriptionId ? t('subscribe.savedEdit') : t('subscribe.saved');
    const recap = buildTrailRecap(state.draft);
    const body = recap.length > 0 ? `${headline}\n\n${recap}` : headline;

    await trailsBot().sendMessage(ctx.chatId, body, {
      parseMode: 'HTML',
      disableWebPagePreview: true,
      replyMarkup: {
        inline_keyboard: [
          [
            {
              text: t('subscribe.manage'),
              callback_data: encodeCallback({ action: 'mg', arg: '-' }),
            },
          ],
        ],
      },
    });
    return { status: 'finalized', subscriptionId: finalizedSubscriptionId };
  }

  const finalText = cleanText.length > 0 ? cleanText : await emptyReplyFallback(ctx);
  await editor.finalize(finalText);

  if (hasConfirm) {
    const t = await getTranslations({ locale: ctx.locale, namespace: 'trails' });
    await trailsBot().editMessageReplyMarkup(ctx.chatId, state.placeholderMessageId!, {
      inline_keyboard: [
        [
          {
            text: t('create.confirmButton'),
            callback_data: encodeCallback({ action: 'tc', arg: '-' }),
          },
        ],
      ],
    });
  }

  return { status: 'continue', state };
}

// ============================================================================
// Helpers
// ============================================================================

function toResponsesInput(args: {
  systemPrompt: string;
  messages: AgentMessage[];
}): OpenAI.Responses.ResponseInputItem[] {
  const items: OpenAI.Responses.ResponseInputItem[] = [
    { role: 'system', content: args.systemPrompt },
  ];
  for (const m of args.messages) {
    if (m.type === 'user_message') {
      items.push({ role: 'user', content: m.content });
    } else if (m.type === 'assistant_message') {
      items.push({ role: 'assistant', content: m.content });
    } else if (m.type === 'function_call') {
      items.push({
        type: 'function_call',
        call_id: m.call_id,
        name: m.name,
        arguments: m.arguments,
      });
    } else if (m.type === 'function_call_output') {
      items.push({
        type: 'function_call_output',
        call_id: m.call_id,
        output: m.output,
      });
    }
  }
  return items;
}

function stripConfirm(s: string): string {
  return s.replace(new RegExp(escapeRegExp(CONFIRM_SENTINEL), 'g'), '');
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function toDisplayText(s: string, fallback: string): string {
  const cleaned = stripConfirm(s).trim();
  return cleaned.length === 0 ? fallback : cleaned;
}

async function randomLoadingPhrase(ctx: AgentTurnContext): Promise<string> {
  const t = await getTranslations({ locale: ctx.locale, namespace: 'trails' });
  const raw = t.raw('create.loadingPhrases');
  const phrases = Array.isArray(raw) ? (raw as string[]) : ['…'];
  const phrase = phrases[Math.floor(Math.random() * phrases.length)] ?? '…';
  return `<tg-spoiler>${escapeHtml(phrase)}</tg-spoiler>`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function errorMessage(ctx: AgentTurnContext): Promise<string> {
  const t = await getTranslations({ locale: ctx.locale, namespace: 'trails' });
  return t('error.generic');
}

async function wrapsUpMessage(ctx: AgentTurnContext): Promise<string> {
  const t = await getTranslations({ locale: ctx.locale, namespace: 'trails' });
  return t('create.turnCap');
}

async function emptyReplyFallback(ctx: AgentTurnContext): Promise<string> {
  const t = await getTranslations({ locale: ctx.locale, namespace: 'trails' });
  return t('create.emptyReply');
}

function buildTrailRecap(draft: TrailDraft): string {
  const blocks: string[] = [];
  if (draft.topicTitle) blocks.push(`<b>${escapeHtml(draft.topicTitle)}</b>`);
  if (draft.description) blocks.push(escapeHtml(draft.description));
  if (draft.sources && draft.sources.length > 0) {
    const sourceList = draft.sources
      .map((s) => `• <a href="https://${escapeHtml(s.domain)}">${escapeHtml(s.domain)}</a>`)
      .join('\n');
    blocks.push(sourceList);
  }
  return blocks.join('\n\n');
}
