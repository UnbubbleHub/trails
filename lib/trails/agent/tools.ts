import { createHash } from 'crypto';
import type { Locale } from '@/i18n/config';
import { getRepo } from '@/lib/repo';
import type { TopicQueryLanguage, TopicSubscriptionDraft } from '@/lib/repo/types';
import { searchNews } from '@/lib/search/client';
import { deriveSearchSpec } from './derive-spec';
import { discoverOutlets, normalizeDomain } from './discover-outlets';
import { dedupeAndPolishPreviewItems } from './polish-titles';
import {
  EXA_CALLS_PER_HOUR_CAP,
  type PreviewSampleItem,
  type ProposedSource,
  type TrailDraft,
} from './types';

const TRAIL_CAP = 10;
const PREVIEW_LOOKBACK_DAYS = 7;
/** Exa hard cap per request. If we hit this, true match count is likely higher. */
const SEARCH_NUM_RESULTS = 25;
const SAMPLE_SIZE = 7;

// ============================================================================
// Tool schemas — passed to OpenAI Responses API
// ============================================================================

export const trailTools = [
  {
    type: 'function' as const,
    name: 'propose_sources',
    description:
      'Suggest reputable news outlets that consistently cover this topic. Call once after the description is settled. Re-call ONLY when (a) the user explicitly asks for different sources ("swap X for Y", "add Z", "find different outlets"), or (b) the topic shifts to a genuinely different subject/geography/beat. Do NOT re-call for filter tweaks, EXCLUDE rules, "focus on / only / just X" requests, narrowing to a sub-topic the existing sources still cover, title changes, or small rewordings. When unsure whether the user wants a re-source or just a filter tightening, ASK them first — do not silently re-call.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        description: {
          type: 'string',
          description: 'The consolidated topic description.',
        },
      },
      required: ['description'],
    },
    strict: true,
  },
  {
    type: 'function' as const,
    name: 'run_preview',
    description:
      'Search news from the last 7 days, restricted to the given domains. ONLY call this after you have proposed a source list and the user has explicitly confirmed it (e.g. tapped Confirm, said "ok", "yes", "looks good"). Do not preview before sources are agreed.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        description: {
          type: 'string',
          description: 'The consolidated topic description.',
        },
        sources: {
          type: 'array',
          items: { type: 'string' },
          description:
            'List of domains to restrict the search to (e.g. ["corriere.it", "theguardian.com"]).',
        },
      },
      required: ['description', 'sources'],
    },
    strict: true,
  },
  {
    type: 'function' as const,
    name: 'finalize_trail',
    description: 'Save the trail. Only call after the user has confirmed the preview.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        description: {
          type: 'string',
          description: 'The final consolidated description.',
        },
        topicTitle: {
          type: 'string',
          description: 'Short label with a leading Unicode emoji.',
        },
        filterRubric: {
          type: 'string',
          description: 'Plaintext bullet checklist (INCLUDE/EXCLUDE/Core entities/Event types).',
        },
        sources: {
          type: 'array',
          items: { type: 'string' },
          description: 'Final list of domains the user agreed to.',
        },
      },
      required: ['description', 'topicTitle', 'filterRubric', 'sources'],
    },
    strict: true,
  },
];

export type TrailToolName = 'propose_sources' | 'run_preview' | 'finalize_trail';

// ============================================================================
// Tool execution
// ============================================================================

export interface ToolContext {
  chatId: number;
  telegramUserId: number;
  locale: Locale;
  /** Stamped on every model call (discoverOutlets, polishPreviewTitles, deriveSearchSpec). */
  conversationId: string;
  editingSubscriptionId?: string;
  /** Mutated by tool executors when they produce results the model will need. */
  draft: TrailDraft;
  /** Increment + check the per-user Exa preview counter. Returns post-increment count. */
  incrementExaCounter: () => Promise<number>;
}

export interface ToolResult {
  /** JSON-serializable payload returned to the model. */
  output: unknown;
  /** Side-effect: if the tool finalized, the runner should end the conversation. */
  finalized?: { subscriptionId: string };
}

export async function executeTool(args: {
  name: string;
  argsJson: string;
  ctx: ToolContext;
}): Promise<ToolResult> {
  const parsed = safeParse(args.argsJson);
  switch (args.name) {
    case 'propose_sources':
      return executeProposeSources(parsed, args.ctx);
    case 'run_preview':
      return executeRunPreview(parsed, args.ctx);
    case 'finalize_trail':
      return executeFinalizeTrail(parsed, args.ctx);
    default:
      return {
        output: { error: 'unknown_tool', message: `Tool ${args.name} not recognized.` },
      };
  }
}

function safeParse(json: string): Record<string, unknown> {
  try {
    return JSON.parse(json);
  } catch {
    return {};
  }
}

// ----------------------------------------------------------------------------
// propose_sources
// ----------------------------------------------------------------------------

async function executeProposeSources(
  parsed: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolResult> {
  const description = typeof parsed.description === 'string' ? parsed.description.trim() : '';
  if (description.length < 10) {
    return {
      output: {
        error: 'description_too_short',
        message: 'Description must be at least 10 characters.',
      },
    };
  }

  ctx.draft.description = description;

  let sources: ProposedSource[];
  try {
    sources = await discoverOutlets({
      description,
      locale: ctx.locale,
    });
  } catch (err) {
    console.error('[TrailsAgent] discoverOutlets failed:', err);
    return {
      output: {
        error: 'discovery_failed',
        message: 'I could not look up sources just now. Try rephrasing or ask me to try again.',
      },
    };
  }

  const prevDomains = new Set((ctx.draft.sources ?? []).map((s) => s.domain));
  const nextDomains = new Set(sources.map((s) => s.domain));
  const domainsChanged =
    prevDomains.size !== nextDomains.size ||
    [...nextDomains].some((d) => !prevDomains.has(d));

  ctx.draft.sources = sources;
  if (domainsChanged) {
    delete ctx.draft.preview;
  }

  return {
    output: {
      sources: sources.map((s) => ({ domain: s.domain, name: s.name, why: s.why })),
    },
  };
}

// ----------------------------------------------------------------------------
// run_preview
// ----------------------------------------------------------------------------

async function executeRunPreview(
  parsed: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolResult> {
  const description = typeof parsed.description === 'string' ? parsed.description.trim() : '';
  const rawSources = Array.isArray(parsed.sources) ? parsed.sources : [];
  const sources = rawSources
    .map((s) => (typeof s === 'string' ? normalizeDomain(s) : null))
    .filter((s): s is string => s !== null);

  if (description.length < 10) {
    return {
      output: {
        error: 'description_too_short',
        message: 'Description must be at least 10 characters.',
      },
    };
  }
  if (sources.length === 0) {
    return {
      output: {
        error: 'no_sources',
        message: 'Pick at least one source before running a preview.',
      },
    };
  }

  // Rate limit.
  const count = await ctx.incrementExaCounter();
  if (count > EXA_CALLS_PER_HOUR_CAP) {
    return {
      output: {
        error: 'rate_limited',
        message: `You've run ${EXA_CALLS_PER_HOUR_CAP} previews in the last hour. Please wait a bit before trying another.`,
      },
    };
  }

  ctx.draft.description = description;

  // Derive (or reuse) searchQuery + queryLanguage. Cache by description hash.
  const specHash = hash(description + '|' + ctx.locale);
  let searchQuery = ctx.draft.searchQuery;
  let queryLanguage: TopicQueryLanguage | undefined = ctx.draft.queryLanguage;
  const cachedHash = (ctx.draft as TrailDraft & { _specHash?: string })._specHash;
  if (!searchQuery || !queryLanguage || cachedHash !== specHash) {
    try {
      const spec = await deriveSearchSpec({
        description,
        locale: ctx.locale,
      });
      searchQuery = spec.searchQuery;
      queryLanguage = spec.queryLanguage;
    } catch (err) {
      console.error('[TrailsAgent] deriveSearchSpec failed:', err);
      return {
        output: {
          error: 'search_spec_failed',
          message: 'I could not build a search query for that. Try rephrasing.',
        },
      };
    }
    ctx.draft.searchQuery = searchQuery;
    ctx.draft.queryLanguage = queryLanguage;
    (ctx.draft as TrailDraft & { _specHash?: string })._specHash = specHash;
  }

  const now = new Date();
  const startPublishedDate = new Date(
    now.getTime() - PREVIEW_LOOKBACK_DAYS * 24 * 60 * 60 * 1000
  ).toISOString();
  const datedQuery = `${searchQuery} ${monthFormatter(ctx.locale).format(now)}`;

  let sample: PreviewSampleItem[] = [];
  let rawMatchCount = 0;
  let uniqueEventCount = 0;
  let capHit = false;
  try {
    const response = await searchNews({
      query: datedQuery,
      numResults: SEARCH_NUM_RESULTS,
      startPublishedDate,
      includeDomains: sources,
    });
    const results = response.results ?? [];
    rawMatchCount = results.length;
    capHit = rawMatchCount >= SEARCH_NUM_RESULTS;

    // Send ALL raw results to dedupe+polish so duplicates across the full
    // window are clustered (not just within the top SAMPLE_SIZE).
    const rawAll = results.map((r, i) => ({
      index: i,
      url: r.url,
      rawTitle: r.title ?? r.url,
      domain: extractDomainFromUrl(r.url),
      publishedAt: r.publishedDate ?? null,
      snippet: (r.highlights?.[0] ?? '').slice(0, 500),
    }));

    let stories: { primaryIndex: number; duplicateIndices: number[]; headline: string }[] = [];
    if (rawAll.length > 0) {
      try {
        stories = await dedupeAndPolishPreviewItems({
          inputs: rawAll.map((r) => ({
            index: r.index,
            rawTitle: r.rawTitle,
            snippet: r.snippet,
            domain: r.domain,
            publishedAt: r.publishedAt,
          })),
          locale: ctx.locale,
          topicDescription: description,
        });
      } catch (err) {
        console.warn(
          '[TrailsAgent] dedupeAndPolishPreviewItems failed, falling back to raw results:',
          err
        );
        // Fallback: one story per raw item, raw title.
        stories = rawAll.map((r) => ({
          primaryIndex: r.index,
          duplicateIndices: [],
          headline: r.rawTitle,
        }));
      }
    }

    uniqueEventCount = stories.length;

    // Sort stories by their primary item's publishedDate descending (newest
    // first; null dates treated as oldest), take top SAMPLE_SIZE, then reverse
    // for chronological display order (oldest → most recent).
    const storyTime = (s: { primaryIndex: number }): number => {
      const p = rawAll[s.primaryIndex];
      return p?.publishedAt ? Date.parse(p.publishedAt) : -Infinity;
    };
    const sortedNewestFirst = [...stories].sort((a, b) => storyTime(b) - storyTime(a));
    const topStories = sortedNewestFirst.slice(0, SAMPLE_SIZE);
    const chronological = [...topStories].reverse();

    const previewNow = new Date();
    sample = chronological
      .map((story) => {
        const r = rawAll[story.primaryIndex];
        if (!r) return null;
        return {
          url: r.url,
          title: story.headline.trim() || r.rawTitle,
          domain: r.domain,
          publishedAt: r.publishedAt,
          relativeDate: formatRelativeDate(r.publishedAt, ctx.locale, previewNow),
          snippet: r.snippet.slice(0, 240),
        };
      })
      .filter((s): s is PreviewSampleItem => s !== null);
  } catch (err) {
    console.error('[TrailsAgent] searchNews failed:', err);
    return {
      output: {
        error: 'search_failed',
        message: 'The news search failed. Try again in a moment.',
      },
    };
  }

  // Weekly frequency = events per 7-day lookback (lookback IS 7 days, so it's
  // identical numerically). When the search cap was hit, this is a lower bound.
  const eventsPerWeek = capHit ? SEARCH_NUM_RESULTS : uniqueEventCount;

  ctx.draft.preview = {
    sample,
    matchCount: uniqueEventCount,
    frequencyPerWeek: eventsPerWeek,
    inputHash: hash(description + '|' + sources.sort().join(',')),
  };

  syncSourcesOrder(ctx.draft, sources);

  return {
    output: {
      // capHit signals the true count may be higher than what we measured.
      capHit,
      // Number of distinct events in the last 7 days (after dedup).
      // When capHit is true this is a lower bound — true count may be higher.
      uniqueEventCount,
      // Raw Exa match count before dedup. For debugging / context only.
      rawMatchCount,
      // Extrapolated weekly rate. When capHit is true, this is "at least N/week".
      eventsPerWeek,
      // Titles are already polished + deduped — render VERBATIM.
      sample: sample.map((s) => ({
        title: s.title,
        domain: s.domain,
        relativeDate: s.relativeDate,
      })),
    },
  };
}

/**
 * Format a publication date as a locale-aware relative phrase: "today",
 * "yesterday", "2 days ago", etc. Returns an empty string when the date is
 * missing or unparseable.
 */
function formatRelativeDate(publishedAt: string | null, locale: Locale, now: Date): string {
  if (!publishedAt) return '';
  const d = new Date(publishedAt);
  if (Number.isNaN(d.getTime())) return '';
  const dayMs = 24 * 60 * 60 * 1000;
  const startOfDay = (x: Date) => Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), x.getUTCDate());
  const daysAgo = Math.max(0, Math.floor((startOfDay(now) - startOfDay(d)) / dayMs));
  try {
    const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
    return rtf.format(-daysAgo, 'day');
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

// ----------------------------------------------------------------------------
// finalize_trail
// ----------------------------------------------------------------------------

async function executeFinalizeTrail(
  parsed: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolResult> {
  const description = typeof parsed.description === 'string' ? parsed.description.trim() : '';
  const topicTitle = typeof parsed.topicTitle === 'string' ? parsed.topicTitle.trim() : '';
  const filterRubric = typeof parsed.filterRubric === 'string' ? parsed.filterRubric.trim() : '';
  const rawSources = Array.isArray(parsed.sources) ? parsed.sources : [];
  const sources = rawSources
    .map((s) => (typeof s === 'string' ? normalizeDomain(s) : null))
    .filter((s): s is string => s !== null);

  if (description.length < 10 || topicTitle.length === 0 || filterRubric.length === 0) {
    return {
      output: {
        error: 'missing_fields',
        message: 'Description, title, and filter rubric are all required.',
      },
    };
  }
  if (sources.length === 0) {
    return {
      output: { error: 'no_sources', message: 'At least one source is required.' },
    };
  }

  // Cap check (skip when editing).
  if (!ctx.editingSubscriptionId) {
    const subCount = await getRepo().subscriptions.countByUser(ctx.telegramUserId);
    if (subCount >= TRAIL_CAP) {
      return {
        output: {
          error: 'cap_reached',
          message: `You've reached the maximum of ${TRAIL_CAP} trails. Delete one before adding another.`,
        },
      };
    }
  }

  // Ensure searchQuery + queryLanguage are derived.
  let searchQuery = ctx.draft.searchQuery;
  let queryLanguage: TopicQueryLanguage | undefined = ctx.draft.queryLanguage;
  const specHash = hash(description + '|' + ctx.locale);
  const cachedHash = (ctx.draft as TrailDraft & { _specHash?: string })._specHash;
  if (!searchQuery || !queryLanguage || cachedHash !== specHash) {
    try {
      const spec = await deriveSearchSpec({
        description,
        locale: ctx.locale,
      });
      searchQuery = spec.searchQuery;
      queryLanguage = spec.queryLanguage;
    } catch (err) {
      console.error('[TrailsAgent] deriveSearchSpec (finalize) failed:', err);
      return {
        output: {
          error: 'search_spec_failed',
          message: 'I could not finalize the trail. Try again.',
        },
      };
    }
  }

  // Account-linking was removed in the standalone build — subscriptions are
  // never tied to an email.
  const email = null;
  const draft: TopicSubscriptionDraft = {
    telegramUserId: ctx.telegramUserId,
    telegramChatId: ctx.chatId,
    email,
    locale: ctx.locale,
    topicTitle,
    topicDescription: description,
    filterRubric,
    searchQuery,
    includeDomains: sources,
    excludeDomains: null,
    queryLanguage,
  };

  let subscriptionId: string;
  if (ctx.editingSubscriptionId) {
    const existing = await getRepo().subscriptions.getById(ctx.editingSubscriptionId);
    if (!existing || existing.telegramUserId !== ctx.telegramUserId) {
      return {
        output: { error: 'not_found', message: 'That trail no longer exists.' },
      };
    }
    await getRepo().subscriptions.updateDraft(ctx.editingSubscriptionId, draft);
    subscriptionId = ctx.editingSubscriptionId;
  } else {
    subscriptionId = await getRepo().subscriptions.create(draft);
  }

  ctx.draft.description = description;
  ctx.draft.topicTitle = topicTitle;
  ctx.draft.filterRubric = filterRubric;
  ctx.draft.searchQuery = searchQuery;
  ctx.draft.queryLanguage = queryLanguage;
  syncSourcesOrder(ctx.draft, sources);

  return {
    output: { ok: true, subscriptionId, topicTitle },
    finalized: { subscriptionId },
  };
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

function hash(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 16);
}

function extractDomainFromUrl(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

function monthFormatter(locale: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  });
}

function syncSourcesOrder(draft: TrailDraft, domains: string[]): void {
  const existing = new Map((draft.sources ?? []).map((s) => [s.domain, s] as const));
  draft.sources = domains.map((d) => existing.get(d) ?? { domain: d, name: d, why: '' });
}
