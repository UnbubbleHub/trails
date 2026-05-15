import probe from 'probe-image-size';

/**
 * Server-only cover-candidate collection + pre-filter for Telegram topic
 * notifications. Gathers up to a handful of plausible cover URLs from the
 * article's HTML metadata, probes each for size/format, and returns the
 * survivors in priority order. The summarizer LLM picks the best one (or
 * rejects all of them).
 */

const PAGE_FETCH_TIMEOUT_MS = 2000;
const PAGE_MAX_BYTES = 64 * 1024;
const PROBE_TIMEOUT_MS = 3000;
const MAX_CANDIDATES = 5;

const MIN_WIDTH = 600;
const MIN_HEIGHT = 315;
const MIN_ASPECT = 0.4;
const MAX_ASPECT = 3.0;

const ACCEPTED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);

/**
 * The exact UA string Telegram itself uses to render link previews. Many
 * publishers (Akamai bot manager, Cloudflare's Super Bot Fight Mode, custom
 * WAFs) whitelist this pattern but block generic "UnbubbleBot/..." UAs —
 * Indian Express, NYT, FT, etc. all 403 anything that isn't a known social-
 * preview bot. Since the page we render IS a Telegram link preview, this UA
 * is both accurate to our purpose and reliable in practice.
 */
const USER_AGENT = 'TelegramBot (like TwitterBot)';

export interface CoverCandidate {
  url: string;
  width: number;
  height: number;
  mime: string;
  /** Where in the discovery order this candidate came from — for debugging. */
  source: CandidateSource;
}

export type CandidateSource = 'search' | 'og:image' | 'twitter:image' | 'link:image_src' | 'jsonld';

export interface CollectCoverCandidatesArgs {
  /**
   * Per-result image URL from the search provider, when available. Exa
   * returns one for most articles; the og:image / twitter:image / jsonld
   * fallbacks below pick up the slack for the rest.
   */
  searchImage: string | null | undefined;
  articleUrl: string;
}

export interface CollectCoverCandidatesResult {
  /** Total raw candidates discovered (pre-dedup, pre-probe). */
  rawCount: number;
  /** Candidates that survived dedup, probing, and pre-filter. */
  candidates: CoverCandidate[];
}

/**
 * Collect cover candidates from the search-provider thumbnail (when present)
 * and the article page's HTML metadata, then pre-filter by format and size.
 * Returns up to MAX_CANDIDATES survivors in priority order.
 *
 * Never throws: any failure (page fetch error, probe error, malformed HTML)
 * just shrinks the candidate list. The caller falls back to a no-cover
 * notification when zero candidates remain.
 */
export async function collectCoverCandidates(
  args: CollectCoverCandidatesArgs
): Promise<CollectCoverCandidatesResult> {
  const raw: { url: string; source: CandidateSource }[] = [];

  if (args.searchImage) {
    const resolved = resolveUrl(args.searchImage, args.articleUrl);
    if (resolved) raw.push({ url: resolved, source: 'search' });
  }

  const html = await fetchPageHead(args.articleUrl).catch(() => null);
  if (html) {
    const metaSources: Array<[string, CandidateSource]> = [
      ['og:image:secure_url', 'og:image'],
      ['og:image:url', 'og:image'],
      ['og:image', 'og:image'],
      ['twitter:image:src', 'twitter:image'],
      ['twitter:image', 'twitter:image'],
    ];
    for (const [property, source] of metaSources) {
      const v = extractMetaContent(html, property);
      if (!v) continue;
      const resolved = resolveUrl(v, args.articleUrl);
      if (resolved) raw.push({ url: resolved, source });
    }

    const linkImg = extractLinkRelImageSrc(html);
    if (linkImg) {
      const resolved = resolveUrl(linkImg, args.articleUrl);
      if (resolved) raw.push({ url: resolved, source: 'link:image_src' });
    }

    for (const url of extractJsonLdImages(html)) {
      const resolved = resolveUrl(url, args.articleUrl);
      if (resolved) raw.push({ url: resolved, source: 'jsonld' });
    }
  }

  const rawCount = raw.length;

  // Dedup by absolute URL; preserve first-seen order so priority is kept.
  const seen = new Set<string>();
  const deduped: { url: string; source: CandidateSource }[] = [];
  for (const c of raw) {
    if (seen.has(c.url)) continue;
    seen.add(c.url);
    deduped.push(c);
    if (deduped.length >= MAX_CANDIDATES) break;
  }

  // Probe in parallel; drop anything that doesn't pass the pre-filter.
  const probed = await Promise.all(
    deduped.map(async (c) => {
      const meta = await probeOne(c.url);
      if (!meta) return null;
      if (!ACCEPTED_MIME.has(meta.mime)) return null;
      if (meta.width < MIN_WIDTH || meta.height < MIN_HEIGHT) return null;
      const ratio = meta.width / meta.height;
      if (ratio < MIN_ASPECT || ratio > MAX_ASPECT) return null;
      return {
        url: c.url,
        width: meta.width,
        height: meta.height,
        mime: meta.mime,
        source: c.source,
      };
    })
  );

  const candidates = probed.filter((c): c is CoverCandidate => c !== null);

  return { rawCount, candidates };
}

async function probeOne(
  url: string
): Promise<{ width: number; height: number; mime: string } | null> {
  try {
    const result = await probe(url, { timeout: PROBE_TIMEOUT_MS });
    if (!result || !result.width || !result.height) return null;
    return { width: result.width, height: result.height, mime: result.mime };
  } catch {
    return null;
  }
}

async function fetchPageHead(url: string): Promise<string | null> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(PAGE_FETCH_TIMEOUT_MS),
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'text/html,application/xhtml+xml',
    },
    redirect: 'follow',
  });
  if (!res.ok) return null;
  const reader = res.body?.getReader();
  if (!reader) return null;
  const decoder = new TextDecoder();
  let html = '';
  let received = 0;
  while (received < PAGE_MAX_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    html += decoder.decode(value, { stream: true });
    if (html.includes('</head>')) break;
  }
  try {
    await reader.cancel();
  } catch {
    // ignore
  }
  return html;
}

function extractMetaContent(html: string, property: string): string | null {
  const patterns = [
    new RegExp(
      `<meta[^>]+(?:property|name)=["']${escapeRegex(property)}["'][^>]+content=["']([^"']+)["']`,
      'i'
    ),
    new RegExp(
      `<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${escapeRegex(property)}["']`,
      'i'
    ),
  ];
  for (const re of patterns) {
    const m = re.exec(html);
    if (m) return decodeHtmlEntities(m[1]);
  }
  return null;
}

function extractLinkRelImageSrc(html: string): string | null {
  const patterns = [
    /<link[^>]+rel=["']image_src["'][^>]+href=["']([^"']+)["']/i,
    /<link[^>]+href=["']([^"']+)["'][^>]+rel=["']image_src["']/i,
  ];
  for (const re of patterns) {
    const m = re.exec(html);
    if (m) return decodeHtmlEntities(m[1]);
  }
  return null;
}

/**
 * Pull image URLs out of any JSON-LD `<script type="application/ld+json">`
 * blocks in the head. Tolerant of bad JSON — failures just yield no images.
 */
function extractJsonLdImages(html: string): string[] {
  const out: string[] = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const body = m[1].trim();
    if (!body) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      continue;
    }
    collectImagesFromJsonLd(parsed, out);
  }
  return out;
}

function collectImagesFromJsonLd(node: unknown, out: string[]): void {
  if (node == null) return;
  if (Array.isArray(node)) {
    for (const item of node) collectImagesFromJsonLd(item, out);
    return;
  }
  if (typeof node !== 'object') return;
  const obj = node as Record<string, unknown>;

  const img = obj.image;
  if (typeof img === 'string') {
    out.push(img);
  } else if (Array.isArray(img)) {
    for (const item of img) {
      if (typeof item === 'string') out.push(item);
      else if (item && typeof item === 'object') {
        const url = (item as Record<string, unknown>).url;
        if (typeof url === 'string') out.push(url);
      }
    }
  } else if (img && typeof img === 'object') {
    const url = (img as Record<string, unknown>).url;
    if (typeof url === 'string') out.push(url);
  }

  // Recurse into common wrappers like `@graph`.
  const graph = obj['@graph'];
  if (graph) collectImagesFromJsonLd(graph, out);
}

function resolveUrl(maybeRelative: string, base: string): string | null {
  try {
    const u = new URL(maybeRelative, base);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.toString();
  } catch {
    return null;
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x2F;/gi, '/');
}
