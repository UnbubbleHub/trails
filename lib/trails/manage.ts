import { getTranslations } from 'next-intl/server';
import type { Locale } from '@/i18n/config';
import { getRepo, parseSubscriptionId } from '@/lib/repo';
import { escapeHtml } from '@/lib/telegram/format';
import { trailsBot } from './bot-api';
import { encodeCallback } from './callback-data';
import { handleEditTrail, handleNewCommand } from './commands';
import { renderManageDetail, renderManageList, type ManageListCopy } from './render';

async function loadCopy(locale: Locale): Promise<ManageListCopy> {
  const t = await getTranslations({ locale, namespace: 'trails' });
  return {
    header: t('manage.header'),
    headerSubtitle: (n) => t('manage.headerSubtitle', { n }),
    empty: t('manage.empty'),
    editLabel: t('manage.edit'),
    allSourcesLabel: t('manage.allSources'),
    deleteLabel: t('manage.delete'),
    newLabel: t('manage.new'),
    backLabel: t('manage.back'),
    prevLabel: t('manage.prev'),
    nextLabel: t('manage.next'),
    pageIndicator: (current, total) => t('manage.pageIndicator', { current, total }),
  };
}

/** Render the /trails list message (a single page). */
export async function renderManageListMessage(args: {
  chatId: number;
  telegramUserId: number;
  locale: Locale;
  page?: number;
}): Promise<void> {
  const subs = await getRepo().subscriptions.listByUser(args.telegramUserId);
  const copy = await loadCopy(args.locale);
  const { text, replyMarkup } = renderManageList({
    subscriptions: subs,
    copy,
    ...(args.page !== undefined && { page: args.page }),
  });
  await trailsBot().sendMessage(args.chatId, text, {
    parseMode: 'HTML',
    disableWebPagePreview: true,
    replyMarkup,
  });
}

/** Render the manage-detail view for a single subscription. */
async function renderManageDetailMessage(args: {
  chatId: number;
  telegramUserId: number;
  locale: Locale;
  subscriptionId: string;
}): Promise<{ found: boolean }> {
  const sub = await getRepo().subscriptions.getById(args.subscriptionId);
  if (!sub || sub.telegramUserId !== args.telegramUserId) {
    return { found: false };
  }
  const copy = await loadCopy(args.locale);
  const { text, replyMarkup } = renderManageDetail({ subscription: sub, copy });
  await trailsBot().sendMessage(args.chatId, text, {
    parseMode: 'HTML',
    disableWebPagePreview: true,
    replyMarkup,
  });
  return { found: true };
}

/** Handle a callback_query from the list (open/page/edit/pause/resume/delete). */
export async function handleManageCallback(args: {
  chatId: number;
  telegramUserId: number;
  locale: Locale;
  action: 'lo' | 'lpg' | 'lE' | 'ld' | 'ldc' | 'sp' | 'spc' | 'mg' | 'nn' | 'bk';
  suffix: string;
  /** Message id of the inline-keyboard message that triggered this callback. */
  promptMessageId?: number;
}): Promise<{ toast?: string }> {
  const t = await getTranslations({ locale: args.locale, namespace: 'trails' });
  const bot = trailsBot();

  if (args.action === 'mg' || args.action === 'bk') {
    await renderManageListMessage({
      chatId: args.chatId,
      telegramUserId: args.telegramUserId,
      locale: args.locale,
    });
    return {};
  }

  if (args.action === 'lpg') {
    const page = Number.parseInt(args.suffix, 10);
    await renderManageListMessage({
      chatId: args.chatId,
      telegramUserId: args.telegramUserId,
      locale: args.locale,
      page: Number.isFinite(page) && page >= 0 ? page : 0,
    });
    return {};
  }

  if (args.action === 'nn') {
    await handleNewCommand({
      chatId: args.chatId,
      telegramUserId: args.telegramUserId,
      locale: args.locale,
    });
    return {};
  }

  const subscriptionId = parseSubscriptionId(args.suffix, args.telegramUserId);
  const sub = await getRepo().subscriptions.getById(subscriptionId);
  if (!sub || sub.telegramUserId !== args.telegramUserId) {
    return { toast: t('error.notFound') };
  }

  switch (args.action) {
    case 'lo': {
      await renderManageDetailMessage({
        chatId: args.chatId,
        telegramUserId: args.telegramUserId,
        locale: args.locale,
        subscriptionId,
      });
      return {};
    }
    case 'lE': {
      await handleEditTrail({
        chatId: args.chatId,
        telegramUserId: args.telegramUserId,
        locale: args.locale,
        subscription: sub,
      });
      return {};
    }
    case 'ld':
    case 'sp': {
      const confirmAction = args.action === 'ld' ? 'ldc' : 'spc';
      const cancelMarkup = {
        inline_keyboard: [
          [
            {
              text: t('manage.deleteConfirm'),
              callback_data: encodeCallback({ action: confirmAction, arg: args.suffix }),
            },
            {
              text: t('manage.cancel'),
              callback_data: encodeCallback({ action: 'bk', arg: '-' }),
            },
          ],
        ],
      };
      await bot.sendMessage(
        args.chatId,
        t.markup('manage.deletePrompt', {
          title: escapeHtml(sub.topicTitle),
          b: (chunks) => `<b>${chunks}</b>`,
        }),
        { parseMode: 'HTML', replyMarkup: cancelMarkup }
      );
      return {};
    }
    case 'ldc':
    case 'spc': {
      await getRepo().subscriptions.delete(subscriptionId);
      await bot.sendMessage(
        args.chatId,
        t.markup('manage.deleteAck', {
          title: escapeHtml(sub.topicTitle),
          b: (chunks) => `<b>${chunks}</b>`,
        }),
        { parseMode: 'HTML' }
      );
      await renderManageListMessage({
        chatId: args.chatId,
        telegramUserId: args.telegramUserId,
        locale: args.locale,
      });
      return { toast: t('manage.deleteAckToast') };
    }
  }

  return {};
}
