import { getTranslations } from 'next-intl/server';
import type { Locale } from '@/i18n/config';
import { getRepo } from '@/lib/repo';
import { mapLocale } from '@/lib/telegram/locale';
import type { TelegramUpdate } from '@/lib/telegram/types';
import { trailsBot } from './bot-api';
import { decodeCallback } from './callback-data';
import {
  driveAgent,
  handleCancel,
  handleHelp,
  handleNewCommand,
  handleStart,
  handleTrailsCommand,
} from './commands';
import { handleManageCallback } from './manage';

/**
 * Entry point invoked by the webhook route. Receives a validated Telegram
 * update and dispatches based on (command vs. text vs. callback_query).
 *
 * Never throws — any unhandled failure is caught, logged, and the user sees a
 * localized error message.
 */
export async function dispatchTrailsUpdate(update: TelegramUpdate): Promise<void> {
  try {
    if (update.message) {
      await dispatchMessage(update);
    } else if (update.callback_query) {
      await dispatchCallbackQuery(update);
    }
  } catch (err) {
    console.error('[TrailsDispatcher] unhandled:', err);
    const chatId = update.message?.chat.id ?? update.callback_query?.message?.chat.id;
    const locale = mapLocale(
      update.message?.from?.language_code ?? update.callback_query?.from.language_code
    );
    if (chatId) {
      try {
        const t = await getTranslations({ locale, namespace: 'trails' });
        await trailsBot().sendMessage(chatId, t('error.generic'));
      } catch {
        // best-effort
      }
    }
  }
}

async function dispatchMessage(update: TelegramUpdate): Promise<void> {
  const message = update.message!;
  if (message.chat.type !== 'private') return;
  const chatId = message.chat.id;
  const telegramUserId = message.from?.id;
  if (!telegramUserId) return;
  const locale = mapLocale(message.from?.language_code);

  const text = (message.text ?? message.caption)?.trim();

  // Command handling (commands take precedence over conversation state).
  if (text) {
    switch (text.split(/\s+/)[0]) {
      case '/start':
        await handleStart({ chatId, locale });
        return;
      case '/help':
        await handleHelp({ chatId, locale });
        return;
      case '/cancel':
        await handleCancel({ chatId, telegramUserId, locale });
        return;
      case '/new': {
        const inline = text.slice('/new'.length).trim();
        await handleNewCommand({
          chatId,
          telegramUserId,
          locale,
          ...(inline && { description: inline }),
        });
        return;
      }
      case '/trails':
        await handleTrailsCommand({ chatId, telegramUserId, locale });
        return;
    }
  }

  if (!text) {
    const t = await getTranslations({ locale, namespace: 'trails' });
    await trailsBot().sendMessage(chatId, t('unknownInput'), { parseMode: 'HTML' });
    return;
  }

  const conv = await getRepo().conversations.get(chatId);
  if (conv.state.type === 'creating_trail') {
    await driveAgent({ chatId, telegramUserId, locale, userInput: text });
    return;
  }

  // Idle + stray text — point at /new or /trails.
  const t = await getTranslations({ locale, namespace: 'trails' });
  await trailsBot().sendMessage(chatId, t('unknownInput'), { parseMode: 'HTML' });
}

async function dispatchCallbackQuery(update: TelegramUpdate): Promise<void> {
  const cq = update.callback_query!;
  const chatId = cq.message?.chat.id;
  const telegramUserId = cq.from.id;
  if (!chatId) return;
  const locale: Locale = mapLocale(cq.from.language_code);
  const bot = trailsBot();

  const payload = decodeCallback(cq.data);
  if (!payload) {
    await bot.answerCallbackQuery(cq.id);
    return;
  }

  switch (payload.action) {
    case 'tc': {
      // "Confirm" button — feed a synthetic user message into the agent.
      await bot.answerCallbackQuery(cq.id);
      // Strip the keyboard from the prompting message so the button can't be tapped twice.
      if (cq.message?.message_id !== undefined) {
        await bot.editMessageReplyMarkup(chatId, cq.message.message_id, null);
      }
      await driveAgent({
        chatId,
        telegramUserId,
        locale,
        userInput: 'Confirm.',
      });
      return;
    }

    case 'mg':
    case 'sp':
    case 'spc':
    case 'lo':
    case 'lpg':
    case 'lE':
    case 'ld':
    case 'ldc':
    case 'nn':
    case 'bk': {
      const result = await handleManageCallback({
        chatId,
        telegramUserId,
        locale,
        action: payload.action,
        suffix: payload.arg,
        ...(cq.message?.message_id !== undefined && { promptMessageId: cq.message.message_id }),
      });
      await bot.answerCallbackQuery(cq.id, result.toast ? { text: result.toast } : undefined);
      return;
    }

    default:
      await bot.answerCallbackQuery(cq.id);
  }
}
