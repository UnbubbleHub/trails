/**
 * Provider-agnostic news search types. Today's only implementation is Exa
 * (`lib/search/client.ts`), but the surface deliberately doesn't leak Exa
 * specifics — pipeline code works against `SearchResult`/`SearchResponse` so a
 * future provider swap stays a one-file change.
 */

/** Single search result. */
export interface SearchResult {
  /** Stable per-result id from the provider. */
  id: string;
  url: string;
  title: string | null;
  /**
   * ISO-8601 publication date when the provider returns one. Exa returns it
   * for most results. Pipeline cross-checks with the LLM-extracted
   * `eventDateIso` for the freshness gate, so missing values are tolerated.
   */
  publishedDate: string | null;
  score?: number | null;
  /**
   * Per-result image URL when the provider supplies one. Exa returns one for
   * most articles; `cover-candidates.ts` falls back to og:image / twitter:image
   * / jsonld extraction from the article HTML for the rest.
   */
  image?: string | null;
  favicon?: string | null;
  /**
   * Query-relevant snippets. The pipeline uses `highlights[0]` as the snippet
   * fed to the meaningful-filter LLM, `highlights[1]` (when present) sliced as
   * the body excerpt for the same filter, and `highlights.join('\n\n')` as the
   * `text` fed to the summarizer.
   *
   * Exa adapter packs `[snippet, body?]` here: index 0 is the joined Exa
   * `highlights` (query-relevant 3-sentence excerpts), index 1 is the
   * truncated full article body (`text` from `contents`).
   */
  highlights?: string[] | null;
}

export interface SearchResponse {
  results: SearchResult[];
  /** Provider request id when available — for debugging. */
  requestId?: string;
}

export interface SearchParams {
  query: string;
  /** Default 10 in production, 25 for the preview pipeline. */
  numResults?: number;
  /** ISO-8601 lower bound on publishedDate. Maps to Exa's `startPublishedDate`. */
  startPublishedDate?: string;
  /** ISO-8601 upper bound on publishedDate. Maps to Exa's `endPublishedDate`. */
  endPublishedDate?: string;
  includeDomains?: string[];
  excludeDomains?: string[];
  signal?: AbortSignal;
}
