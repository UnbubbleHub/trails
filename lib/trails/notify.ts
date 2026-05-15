import { getTranslations } from 'next-intl/server';
import type { Locale } from '@/i18n/config';
import { pickMeaningfulUpdates, type MeaningfulCandidate } from '@/lib/ai/steps/topic-meaningful';
import { summarizeArticle } from '@/lib/ai/steps/topic-summarize';
import { getRepo } from '@/lib/repo';
import type { TopicSubscriptionRecord } from '@/lib/repo/types';
import { searchNews } from '@/lib/search/client';
import type { SearchResult } from '@/lib/search/types';
import { trailsBot } from './bot-api';
import { collectCoverCandidates } from './cover-candidates';
import { hashUrl } from './hash-url';
import {
  CAPTION_LIMIT,
  extractDomain,
  renderNotification,
  truncateCaption,
  type NotificationCopy,
} from './render';

const SEARCH_LOOKBACK_BUFFER_MS = 4 * 60 * 60 * 1000;
const SEARCH_NUM_RESULTS = 20;
const MAX_PICKS_PER_RUN = 3;
const STALE_EVENT_MAX_AGE_MS = 2 * 24 * 60 * 60 * 1000;
/**
 * Max chars of `raw_content` (the truncated article body) included in each
 * meaningful-filter candidate. Plenty for the cheap pre-screen to judge
 * substance without bloating a prompt that already sees up to 20 candidates.
 */
const MEANINGFUL_BODY_EXCERPT_CHARS = 400;

function dayFormatter(locale: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

export interface NotifyResult {
  subscriptionId: string;
  notifiedCount: number;
  skipped: boolean;
  skippedReason?: string;
  error?: string;
}

/**
 * Process a single subscription: find new search matches since `lastCheckedAt`,
 * LLM-filter to meaningful updates, summarize, and send.
 *
 * Always advances `lastCheckedAt` + `nextCheckDue` on success OR on send-side
 * failures (to avoid re-processing the same window forever). Does NOT advance
 * if the search call itself failed — those retry next run.
 */
export async function runSubscriptionNotifications(
  sub: TopicSubscriptionRecord
): Promise<NotifyResult> {
  const repo = getRepo();
  const now = new Date();
  const searchStart = new Date(sub.lastCheckedAt.getTime() - SEARCH_LOOKBACK_BUFFER_MS);

  // 1. News search (Exa)
  // Append today's + yesterday's date to the query as a soft recency hint
  // on top of the absolute publishedDate window — biases ranking toward
  // freshly-dated content. Use the subscription's locale so the date tokens
  // match the language the local press uses ("11 maggio 2026" for it,
  // "11. Mai 2026" for de, …).
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const fmt = dayFormatter(sub.locale);
  const datedQuery = `${sub.searchQuery} ${fmt.format(now)} ${fmt.format(yesterday)}`;

  let searchResults: SearchResult[];
  try {
    const response = await searchNews({
      query: datedQuery,
      numResults: SEARCH_NUM_RESULTS,
      startPublishedDate: searchStart.toISOString(),
      endPublishedDate: now.toISOString(),
      includeDomains: sub.includeDomains ?? undefined,
      excludeDomains: sub.excludeDomains ?? undefined,
    });
    searchResults = response.results ?? [];
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[TopicsCron] search failed for sub ${sub.id}: ${message}`);
    // Don't advance lastCheckedAt — try again next run.
    return {
      subscriptionId: sub.id,
      notifiedCount: 0,
      skipped: true,
      error: `search: ${message}`,
    };
  }

  if (searchResults.length === 0) {
    await repo.subscriptions.markChecked(sub.id, now);
    return { subscriptionId: sub.id, notifiedCount: 0, skipped: false };
  }

  // 2. Dedup vs. recent sent URLs, and within the search response itself
  //    (providers occasionally return the same URL twice under different ids).
  const recent = await repo.notifications.getRecent(sub.id, 100);
  const sentHashes = new Set(recent.map((n) => n.urlHash));
  const seenInResponse = new Set<string>();
  const freshResults = searchResults.filter((r) => {
    const h = hashUrl(r.url);
    if (sentHashes.has(h)) {
      return false;
    }
    if (seenInResponse.has(h)) {
      return false;
    }
    seenInResponse.add(h);
    return true;
  });

  if (freshResults.length === 0) {
    await repo.subscriptions.markChecked(sub.id, now);
    return { subscriptionId: sub.id, notifiedCount: 0, skipped: false };
  }

  // 3. Meaningful-update LLM filter
  // `highlights[0]` is the relevance snippet (joined Exa highlights);
  // `highlights[1]` is the truncated full article body (Exa `text`). Pass
  // both — the snippet alone is too thin for the filter to rule out
  // EXCLUDE-rubric matches (recap/explainer/syndication) reliably.
  const candidates: MeaningfulCandidate[] = freshResults.map((r) => {
    const rawBody = r.highlights?.[1] ?? '';
    const bodyExcerpt =
      rawBody.length > MEANINGFUL_BODY_EXCERPT_CHARS
        ? rawBody.slice(0, MEANINGFUL_BODY_EXCERPT_CHARS - 1).trimEnd() + '…'
        : rawBody;
    return {
      searchId: r.id,
      title: r.title ?? '',
      url: r.url,
      publishedAt: r.publishedDate,
      snippet: r.highlights?.[0] ?? '',
      bodyExcerpt,
    };
  });

  let picks: { searchId: string; rationale: string }[];
  try {
    picks = await pickMeaningfulUpdates({
      topicDescription: sub.topicDescription,
      filterRubric: sub.filterRubric ?? '',
      recentSent: recent.slice(0, 10).map((n) => ({
        headline: n.headline,
        summary: n.summary,
        publishedAt: n.publishedAt ? n.publishedAt.toISOString() : null,
      })),
      candidates,
      maxPicks: MAX_PICKS_PER_RUN,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[TopicsCron] meaningful filter failed for sub ${sub.id}: ${message}`);
    await repo.subscriptions.markChecked(sub.id, now);
    return {
      subscriptionId: sub.id,
      notifiedCount: 0,
      skipped: false,
      error: `meaningful: ${message}`,
    };
  }

  picks = dedupePicksBySearchId(picks);

  if (picks.length === 0) {
    await repo.subscriptions.markChecked(sub.id, now);
    return { subscriptionId: sub.id, notifiedCount: 0, skipped: false };
  }

  // 4. Send each pick sequentially (avoid Telegram per-chat throttling)
  const copy = await loadNotificationCopy(sub.locale, sub.topicTitle);
  const bot = trailsBot();
  let notifiedCount = 0;

  // Recent-sent context the meaningful filter saw, reused as a second-pass
  // gate inside the summarizer (which has access to the full article body).
  // We also append picks sent earlier in THIS run so the summarizer can reject
  // syndicated/aggregated near-duplicates that escaped URL-hash dedup.
  const recentSentForSummary = recent.slice(0, 10).map((n) => ({
    headline: n.headline,
    summary: n.summary,
    publishedAt: n.publishedAt ? n.publishedAt.toISOString() : null,
  }));
  const sentInRunHashes = new Set<string>();

  for (const pick of picks) {
    const result = freshResults.find((r) => r.id === pick.searchId);
    if (!result) continue;

    if (sentInRunHashes.has(hashUrl(result.url))) {
      console.log(
        `[TopicsCron] skipping ${result.url} for sub ${sub.id} — already sent earlier this run`
      );
      continue;
    }

    try {
      const text = (result.highlights ?? []).join('\n\n') || result.title || '';

      const coverResult = await collectCoverCandidates({
        searchImage: result.image ?? null,
        articleUrl: result.url,
      });

      const summary = await summarizeArticle({
        locale: sub.locale,
        topicTitle: sub.topicTitle,
        topicDescription: sub.topicDescription,
        filterRubric: sub.filterRubric ?? '',
        recentSent: recentSentForSummary,
        title: result.title ?? '',
        url: result.url,
        publishedAt: result.publishedDate ?? null,
        text,
        coverCandidates: coverResult.candidates.map((c) => c.url),
      });

      if (!summary.meaningful) {
        console.log(
          `[TopicsCron] skipping ${result.url} for sub ${sub.id} — not meaningful: ${summary.skipReason}`
        );
        continue;
      }

      const eventDate = parseEventDate(summary.eventDateIso);
      if (eventDate && now.getTime() - eventDate.getTime() > STALE_EVENT_MAX_AGE_MS) {
        const ageDays = Math.round((now.getTime() - eventDate.getTime()) / (24 * 60 * 60 * 1000));
        console.log(
          `[TopicsCron] skipping ${result.url} for sub ${sub.id} — event ${summary.eventDateIso} is ${ageDays}d old (>2d threshold)`
        );
        continue;
      }

      const cover = summary.selectedCoverUrl;

      const { text: msgText, replyMarkup } = renderNotification({
        subscriptionId: sub.id,
        headline: summary.headline,
        summary: summary.summary,
        articleUrl: result.url,
        sourceDomain: extractDomain(result.url),
        copy,
      });

      let messageId: number | undefined;
      if (cover) {
        messageId = await bot.sendPhoto(sub.telegramChatId, cover, {
          caption: truncateCaption(msgText),
          parseMode: 'HTML',
          replyMarkup,
        });
        if (!messageId) {
          messageId = await bot.sendMessage(sub.telegramChatId, msgText, {
            parseMode: 'HTML',
            disableWebPagePreview: true,
            replyMarkup,
          });
        }
      } else {
        messageId = await bot.sendMessage(sub.telegramChatId, msgText, {
          parseMode: 'HTML',
          disableWebPagePreview: true,
          replyMarkup,
        });
      }

      if (!messageId) {
        // Couldn't send — don't record. Continue to the next pick.
        continue;
      }

      await repo.notifications.create({
        subscriptionId: sub.id,
        telegramUserId: sub.telegramUserId,
        searchResultId: result.id,
        url: result.url,
        urlHash: hashUrl(result.url),
        title: result.title ?? '',
        headline: summary.headline,
        summary: summary.summary,
        publishedAt: result.publishedDate ? new Date(result.publishedDate) : null,
        sentAt: now,
        telegramMessageId: messageId,
        coverImageUrl: cover ?? null,
      });

      await repo.subscriptions.recordNotificationSent(sub.id, now);
      notifiedCount++;

      // Track this send so subsequent picks in the same run can dedupe against
      // it — both via URL hash (cheap) and via the summarizer's recentSent
      // context (catches syndicated/aggregated near-duplicates).
      sentInRunHashes.add(hashUrl(result.url));
      recentSentForSummary.unshift({
        headline: summary.headline,
        summary: summary.summary,
        publishedAt: result.publishedDate ?? null,
      });
    } catch (err) {
      console.error(`[TopicsCron] failed to send for sub ${sub.id}, pick ${pick.searchId}:`, err);
    }
  }

  // 5. Advance checkpoints
  await repo.subscriptions.markChecked(sub.id, now);

  return { subscriptionId: sub.id, notifiedCount, skipped: false };
}

async function loadNotificationCopy(locale: Locale, topic: string): Promise<NotificationCopy> {
  const t = await getTranslations({ locale, namespace: 'trails' });
  return {
    footer: t('notification.footer', { topic }),
    manageLabel: t('notification.manage'),
    stopLabel: t('notification.stop'),
  };
}

/**
 * The meaningful-filter LLM occasionally returns the same searchId twice.
 * Without dedup, the loop would process that candidate twice: iter 1 sends the
 * message, iter 2 sees the URL hash in `sentInRunHashes` and skips. The send
 * really happened, but `picks` would overcount. Dedup up front keeps the
 * accounting honest.
 */
function dedupePicksBySearchId(
  picks: { searchId: string; rationale: string }[]
): { searchId: string; rationale: string }[] {
  const seen = new Set<string>();
  return picks.filter((p) => {
    if (seen.has(p.searchId)) return false;
    seen.add(p.searchId);
    return true;
  });
}

/**
 * Parse the LLM-extracted YYYY-MM-DD event date. Returns null for missing,
 * malformed, or implausible values (e.g. future-dated, year < 2000) so the
 * freshness gate doesn't accidentally block on garbage input.
 */
function parseEventDate(iso: string | null): Date | null {
  if (!iso) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  if (d.getUTCFullYear() < 2000) return null;
  if (d.getTime() > Date.now() + 24 * 60 * 60 * 1000) return null;
  return d;
}

export { CAPTION_LIMIT };
