import { suffixOfSubscriptionId } from '@/lib/repo';
import type { TopicSubscriptionRecord } from '@/lib/repo/types';
import type { InlineKeyboardButton } from '@/lib/telegram/bot-api';
import { escapeHtml, truncateHtml } from '@/lib/telegram/format';
import { encodeCallback } from './callback-data';

/** Caption limit for Telegram photo messages. */
export const CAPTION_LIMIT = 1024;

export interface NotificationCopy {
  footer: string;
  manageLabel: string;
  stopLabel: string;
}

export interface ManageListCopy {
  header: string;
  /** One-line description shown below the header on the non-empty list. */
  headerSubtitle: (n: number) => string;
  empty: string;
  editLabel: string;
  allSourcesLabel: string;
  deleteLabel: string;
  newLabel: string;
  backLabel: string;
  prevLabel: string;
  nextLabel: string;
  pageIndicator: (current: number, total: number) => string;
}

export interface RenderedNotification {
  text: string;
  replyMarkup: { inline_keyboard: InlineKeyboardButton[][] };
}

/** Render a single live notification sent by the cron. */
export function renderNotification(args: {
  subscriptionId: string;
  headline: string;
  summary: string;
  articleUrl: string;
  sourceDomain: string | null;
  copy: NotificationCopy;
}): RenderedNotification {
  const { subscriptionId, headline, summary, articleUrl, sourceDomain, copy } = args;

  const headlineLink = `<b>${escapeHtml(headline)}</b>`;
  const sourceLine = sourceDomain
    ? `<a href="${escapeHtml(articleUrl)}">${escapeHtml(sourceDomain)}</a>`
    : '';
  const summaryLine = `${escapeHtml(summary)}`;

  const text = `${headlineLink}\n\n${summaryLine}\n\n${sourceLine}\n<i>${escapeHtml(copy.footer)}</i>`;

  const suffix = suffixOfSubscriptionId(subscriptionId);
  const replyMarkup: { inline_keyboard: InlineKeyboardButton[][] } = {
    inline_keyboard: [
      [
        {
          text: copy.manageLabel,
          callback_data: encodeCallback({ action: 'mg', arg: suffix }),
        },
        {
          text: copy.stopLabel,
          callback_data: encodeCallback({ action: 'sp', arg: suffix }),
        },
      ],
    ],
  };

  return { text, replyMarkup };
}

export function truncateCaption(text: string): string {
  return truncateHtml(text, CAPTION_LIMIT);
}

/** Number of topics shown per page in the manage list. */
export const MANAGE_PAGE_SIZE = 8;

/** Max length of a topic title rendered inside an inline keyboard button. */
const MANAGE_BUTTON_TITLE_MAX = 50;

function truncateTitleForButton(title: string): string {
  if (title.length <= MANAGE_BUTTON_TITLE_MAX) return title;
  return `${title.slice(0, MANAGE_BUTTON_TITLE_MAX - 1).trimEnd()}…`;
}

/**
 * Render the `/trails` list message: header text only, with one button per
 * subscription (the topic title) followed by an optional `‹ | ›` pager when
 * there are more than {@link MANAGE_PAGE_SIZE} topics, and a "New" button at
 * the bottom. Tapping a topic opens the detail view (`renderManageDetail`).
 */
export function renderManageList(args: {
  subscriptions: TopicSubscriptionRecord[];
  copy: ManageListCopy;
  page?: number;
}): RenderedNotification {
  const { subscriptions, copy } = args;

  if (subscriptions.length === 0) {
    return {
      text: `<b>${escapeHtml(copy.header)}</b>\n\n${escapeHtml(copy.empty)}`,
      replyMarkup: {
        inline_keyboard: [
          [{ text: copy.newLabel, callback_data: encodeCallback({ action: 'nn', arg: '-' }) }],
        ],
      },
    };
  }

  const totalPages = Math.max(1, Math.ceil(subscriptions.length / MANAGE_PAGE_SIZE));
  const page = Math.min(Math.max(0, args.page ?? 0), totalPages - 1);
  const pageStart = page * MANAGE_PAGE_SIZE;
  const pageItems = subscriptions.slice(pageStart, pageStart + MANAGE_PAGE_SIZE);

  const rows: InlineKeyboardButton[][] = [];
  pageItems.forEach((s) => {
    const suffix = suffixOfSubscriptionId(s.id);
    const titleLabel = truncateTitleForButton(s.topicTitle);
    rows.push([{ text: titleLabel, callback_data: encodeCallback({ action: 'lo', arg: suffix }) }]);
  });

  if (totalPages > 1) {
    const pagerRow: InlineKeyboardButton[] = [];
    if (page > 0) {
      pagerRow.push({
        text: copy.prevLabel,
        callback_data: encodeCallback({ action: 'lpg', arg: String(page - 1) }),
      });
    }
    pagerRow.push({
      text: copy.pageIndicator(page + 1, totalPages),
      callback_data: encodeCallback({ action: 'lpg', arg: String(page) }),
    });
    if (page < totalPages - 1) {
      pagerRow.push({
        text: copy.nextLabel,
        callback_data: encodeCallback({ action: 'lpg', arg: String(page + 1) }),
      });
    }
    rows.push(pagerRow);
  }

  rows.push([{ text: copy.newLabel, callback_data: encodeCallback({ action: 'nn', arg: '-' }) }]);

  const text =
    `<b>${escapeHtml(copy.header)}</b>\n\n` +
    `<i>${escapeHtml(copy.headerSubtitle(subscriptions.length))}</i>`;
  return { text, replyMarkup: { inline_keyboard: rows } };
}

/**
 * Render the manage-detail view for a single subscription: title and
 * description, plus Edit / Delete and a Back button to return to the list.
 */
export function renderManageDetail(args: {
  subscription: TopicSubscriptionRecord;
  copy: ManageListCopy;
}): RenderedNotification {
  const { subscription: s, copy } = args;
  const suffix = suffixOfSubscriptionId(s.id);

  let text = `<b>${escapeHtml(s.topicTitle)}</b>`;
  if (s.topicDescription) {
    text += `\n\n${escapeHtml(s.topicDescription)}`;
  }
  if (s.includeDomains && s.includeDomains.length > 0) {
    const sourceList = s.includeDomains
      .map((d) => `• <a href="https://${escapeHtml(d)}">${escapeHtml(d)}</a>`)
      .join('\n');
    text += `\n\n${sourceList}`;
  } else {
    text += `\n\n<i>${escapeHtml(copy.allSourcesLabel)}</i>`;
  }

  const rows: InlineKeyboardButton[][] = [
    [{ text: copy.editLabel, callback_data: encodeCallback({ action: 'lE', arg: suffix }) }],
    [{ text: copy.deleteLabel, callback_data: encodeCallback({ action: 'ld', arg: suffix }) }],
    [{ text: copy.backLabel, callback_data: encodeCallback({ action: 'bk', arg: '-' }) }],
  ];

  return { text, replyMarkup: { inline_keyboard: rows } };
}

export function extractDomain(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}
