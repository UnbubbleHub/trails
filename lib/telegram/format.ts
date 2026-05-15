/** Escape special HTML characters for Telegram HTML parse mode */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Strip inline context references like {{ctx:0:Label}} → Label */
export function stripCtxRefs(text: string): string {
  return text.replace(/\{\{ctx:\d+:([^}]+)\}\}/g, '$1');
}

/**
 * Truncate HTML text to a maximum length while keeping tags balanced.
 * Counts only visible characters (not markup) against the limit.
 * If truncation is needed, appends '...' and closes any open tags.
 */
export function truncateHtml(html: string, maxLen: number): string {
  // Telegram HTML supports: <b>, <i>, <u>, <s>, <code>, <pre>, <a href="...">, <tg-spoiler>, <blockquote>
  const TAG_RE = /<\/?[a-z][a-z0-9-]*(?:\s[^>]*)?\s*>/gi;
  const openTags: string[] = [];
  let visibleLen = 0;
  let lastIndex = 0;
  let result = '';
  let match: RegExpExecArray | null;

  while ((match = TAG_RE.exec(html)) !== null) {
    // Add visible text between previous tag and this one
    const textBefore = html.slice(lastIndex, match.index);
    const remaining = maxLen - visibleLen;

    if (visibleLen + textBefore.length > maxLen) {
      // Truncate inside this text segment
      result += textBefore.slice(0, remaining - 1) + '\u2026';
      // Close all open tags in reverse order
      for (let i = openTags.length - 1; i >= 0; i--) {
        result += `</${openTags[i]}>`;
      }
      return result;
    }

    result += textBefore;
    visibleLen += textBefore.length;

    // Process the tag itself (doesn't count toward visible length)
    const tag = match[0];
    result += tag;

    if (tag.startsWith('</')) {
      // Closing tag — pop from stack
      const tagName = tag.match(/<\/([a-z][a-z0-9-]*)/i)?.[1]?.toLowerCase();
      const idx = openTags.lastIndexOf(tagName ?? '');
      if (idx !== -1) openTags.splice(idx, 1);
    } else {
      // Opening tag — push onto stack
      const tagName = tag.match(/<([a-z][a-z0-9-]*)/i)?.[1]?.toLowerCase();
      if (tagName) openTags.push(tagName);
    }

    lastIndex = match.index + tag.length;
  }

  // Handle remaining text after the last tag
  const tail = html.slice(lastIndex);
  if (visibleLen + tail.length > maxLen) {
    const remaining = maxLen - visibleLen;
    result += tail.slice(0, remaining - 1) + '\u2026';
    for (let i = openTags.length - 1; i >= 0; i--) {
      result += `</${openTags[i]}>`;
    }
    return result;
  }

  // No truncation needed
  return html;
}

/** Max summary points shown inline; extras become a "+N more" link */
export const MAX_INLINE_POINTS = 3;

/** Telegram caption limit (characters after entity parsing) */
export const CAPTION_LIMIT = 1024;

export interface TelegramMessageParams {
  wrapUrl: string;
  title?: string;
  summary?: string;
  skeletonSummary?: string;
  keyFactsCount?: number;
  perspectives?: { emoji: string; title: string; interpretation: string }[];
  imageSourceName?: string;
  statusLine?: string;
  t: {
    unbubbled: (title: string, wrapUrl: string) => string;
    unbubbling: (wrapUrl: string) => string;
    keyFacts: string;
    theDebate: string;
    imageSource: string;
    readMore: string;
    explore: string;
  };
}

export interface TelegramMessageResult {
  text: string;
  replyMarkup?: { inline_keyboard: { text: string; url: string }[][] };
}

/**
 * Build a Telegram HTML message with optional inline keyboard.
 * Used for both streaming (webhook) and broadcast (daily digest) messages.
 */
export function buildTelegramMessage(params: TelegramMessageParams): TelegramMessageResult {
  const {
    wrapUrl,
    title,
    summary,
    skeletonSummary,
    keyFactsCount,
    perspectives,
    imageSourceName,
    statusLine,
    t,
  } = params;
  const interactiveUrl = wrapUrl.replace(/(\?|$)/, '/interactive$1');
  const lines: string[] = [];

  // Header
  if (title) {
    lines.push(t.unbubbled(title, wrapUrl));
  } else {
    lines.push(t.unbubbling(wrapUrl));
  }

  // Summary or skeleton
  if (summary) {
    lines.push('', escapeHtml(summary));
  } else if (skeletonSummary) {
    lines.push('', `<tg-spoiler>${escapeHtml(skeletonSummary)}</tg-spoiler>`);
  }

  // Key facts link
  if (keyFactsCount && keyFactsCount > 0) {
    lines.push('', `💡 <a href="${wrapUrl}">${escapeHtml(t.keyFacts)}</a>`);
  }

  // Perspectives (the debate)
  if (perspectives && perspectives.length > 0) {
    lines.push('', `<b>${escapeHtml(t.theDebate)}</b>`);
    for (const p of perspectives.slice(0, 2)) {
      lines.push('');
      lines.push(`${p.emoji} <b><a href="${wrapUrl}">${escapeHtml(p.title)}</a></b>`);
      lines.push(`<blockquote>${escapeHtml(p.interpretation)}</blockquote>`);
    }
  }

  // Image source credit
  if (imageSourceName) {
    lines.push('', t.imageSource);
  }

  // Streaming mode: append status line, no reply markup
  if (statusLine) {
    const statusBlock = `\n\n${statusLine}`;
    const visibleStatusLen = statusBlock.replace(/<[^>]+>/g, '').length;
    const mainText = truncateHtml(lines.join('\n'), CAPTION_LIMIT - visibleStatusLen);
    return { text: mainText + statusBlock };
  }

  // Final mode: reply markup with buttons
  const replyMarkup = {
    inline_keyboard: [
      [
        { text: t.readMore, url: wrapUrl },
        { text: t.explore, url: interactiveUrl },
      ],
    ],
  };

  return { text: truncateHtml(lines.join('\n'), CAPTION_LIMIT), replyMarkup };
}
