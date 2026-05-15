import type { SearchParams, SearchResponse, SearchResult } from './types';

const EXA_BASE_URL = 'https://api.exa.ai';

/**
 * Cap on the article body (`text` from Exa contents) packed into each result's
 * `highlights[1]`. Bounds summarizer token cost: long-form journalism can run
 * 50k+ chars, but the summarizer doesn't benefit beyond the first ~30k.
 */
const TEXT_TRUNCATE_CHARS = 30_000;

function getApiKey(): string {
  const key = process.env.EXA_API_KEY;
  if (!key) throw new Error('EXA_API_KEY is not set');
  return key;
}

interface ExaApiResult {
  id: string;
  url: string;
  title: string | null;
  publishedDate?: string | null;
  author?: string | null;
  score?: number | null;
  image?: string | null;
  favicon?: string | null;
  /** Exa returns up to `highlightsPerUrl` query-relevant excerpts. */
  highlights?: string[] | null;
  /** Full article body (markdown-ish), present when `contents.text` is requested. */
  text?: string | null;
}

interface ExaApiResponse {
  results: ExaApiResult[];
  requestId?: string;
  autopromptString?: string;
}

/**
 * Exa-backed news search. Provider-agnostic surface — see `SearchParams` /
 * `SearchResult`. The pipeline shouldn't see Exa specifics.
 *
 * Choices baked in here (NOT exposed as params, since the pipeline always
 * wants them this way):
 *   - `type: 'auto'` — Exa picks neural vs keyword per query. Better recall
 *     than fixed `'neural'` for the dated, keyword-flavored queries the
 *     pipeline appends ("<topic> May 11 2026 May 10 2026").
 *   - `contents.text` (capped to TEXT_TRUNCATE_CHARS) — full article body for
 *     the summarizer.
 *   - `contents.highlights` (3 sentences × 5 per url, biased to the search
 *     query) — query-relevant excerpts joined into the snippet the
 *     meaningful-filter LLM sees.
 *   - `contents.livecrawl: 'fallback'` — only fetch live when Exa's cache
 *     doesn't have the page; keeps latency bounded.
 *
 * Notably NOT set: `category: 'news'`. In practice it filters out plenty of
 * legitimate news pages while letting non-news through; the downstream LLM
 * filter + per-source rubric do the gating instead.
 */
export async function searchNews(params: SearchParams): Promise<SearchResponse> {
  const {
    query,
    numResults = 10,
    startPublishedDate,
    endPublishedDate,
    includeDomains,
    excludeDomains,
    signal,
  } = params;

  const body: Record<string, unknown> = {
    query,
    numResults,
    type: 'auto',
    contents: {
      text: { maxCharacters: TEXT_TRUNCATE_CHARS },
      highlights: { numSentences: 3, highlightsPerUrl: 5, query },
      livecrawl: 'fallback',
    },
  };

  if (startPublishedDate) body.startPublishedDate = startPublishedDate;
  if (endPublishedDate) body.endPublishedDate = endPublishedDate;
  if (includeDomains?.length) body.includeDomains = includeDomains;
  if (excludeDomains?.length) body.excludeDomains = excludeDomains;

  const res = await fetch(`${EXA_BASE_URL}/search`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': getApiKey(),
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Exa search failed (${res.status}): ${text}`);
  }

  const apiResponse = (await res.json()) as ExaApiResponse;
  return adaptExaResponse(apiResponse);
}

function adaptExaResponse(api: ExaApiResponse): SearchResponse {
  const results: SearchResult[] = (api.results ?? []).map(adaptExaResult);
  return { results, requestId: api.requestId };
}

function adaptExaResult(r: ExaApiResult): SearchResult {
  // Pack into the highlights array per the SearchResult contract:
  //   [0] = snippet (joined Exa highlights — fed to the meaningful-filter LLM)
  //   [1] = body    (truncated article text — sliced for the filter's
  //                  bodyExcerpt, and joined into summarizer input)
  // Skip empty entries so `highlights.join('\n\n')` doesn't add stray newlines.
  const snippet = r.highlights?.length ? r.highlights.join(' ') : '';
  const rawText = r.text ?? '';
  const body =
    rawText.length > TEXT_TRUNCATE_CHARS
      ? rawText.slice(0, TEXT_TRUNCATE_CHARS - 1).trimEnd() + '…'
      : rawText;

  const highlights: string[] = [];
  if (snippet) highlights.push(snippet);
  if (body) highlights.push(body);

  return {
    id: r.id,
    url: r.url,
    title: r.title || null,
    publishedDate: r.publishedDate ?? null,
    score: r.score ?? null,
    image: r.image ?? null,
    favicon: r.favicon ?? null,
    highlights,
  };
}
