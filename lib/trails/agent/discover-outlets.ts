import { localeNames, type Locale } from '@/i18n/config';
import { openai, parseResponseOutput, validateResponse } from '@/lib/ai/client';
import type { ProposedSource } from './types';

const OUTLETS_MODEL = 'gpt-5.4-mini' as const;
const SERVICE_TIER = 'auto' as const;
const REASONING_EFFORT = 'low' as const;

const OUTLETS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    suggestedSources: {
      type: 'array',
      minItems: 0,
      maxItems: 5,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          domain: { type: 'string', maxLength: 80 },
          name: { type: 'string', maxLength: 80 },
          rationale: { type: 'string', maxLength: 200 },
        },
        required: ['domain', 'name', 'rationale'],
      },
    },
  },
  required: ['suggestedSources'],
} as const;

const OUTLETS_SYSTEM_PROMPT = `You receive a short news-topic description plus a user locale hint. Use the web_search tool to find reputable news outlets that consistently cover this topic in the user's locale (or, when the topic is global, in the relevant Anglophone markets). Return them in suggestedSources, ordered most-relevant-first.

Rules for suggestedSources:
- Prefer specialist outlets and dedicated beat coverage over generic national newspapers when both exist. The goal is high signal-per-article; a local-news site that covers a city's transit beat consistently is more valuable than a national paper that mentions it occasionally.
- Reject content farms, SEO mills, link aggregators, and outlets that mostly republish wire copy. If you're not confident a publisher does original reporting on this topic, leave it off.
- Avoid outlets that only occasionally touch the topic — every entry should be a publisher you'd realistically expect to publish about this topic at least every few weeks.
- Aim for 3–5 sources total. Tight beats noisy — a focused list of 4 publishers is better than 5 padded with weaker picks. Returning fewer than 3 is fine if the topic is genuinely covered by only 1–2 outlets.
- Use registrable domains, lowercase, no protocol or path. Examples: "corriere.it", "milanotoday.it", "theguardian.com". Never invent domains.
- "name" is a short outlet name suitable for UI display (e.g., "Corriere della Sera", "MilanoToday").
- "rationale" is one short sentence explaining why this outlet covers the topic well — used internally for review.

Do not refuse. Do not ask follow-up questions. Always produce the JSON.`;

/**
 * Suggest reputable outlets covering the topic via gpt-5-mini + web_search.
 * Migrated from `lib/ai/steps/topic-query-gen.ts:discoverOutlets`.
 */
export async function discoverOutlets(args: {
  description: string;
  locale: Locale;
}): Promise<ProposedSource[]> {
  const response = await openai.responses.create({
    model: OUTLETS_MODEL,
    service_tier: SERVICE_TIER,
    reasoning: { effort: REASONING_EFFORT, summary: 'concise' },
    tools: [{ type: 'web_search_preview' }],
    input: [
      { role: 'system', content: OUTLETS_SYSTEM_PROMPT },
      {
        role: 'user',
        content: `User's locale hint: ${localeNames[args.locale]}.\n\ntopicDescription: ${args.description}`,
      },
    ],
    text: {
      format: {
        type: 'json_schema',
        name: 'outlet_suggestions',
        strict: true,
        schema: OUTLETS_SCHEMA,
      },
    },
  });

  validateResponse(response, 'discoverOutlets');
  const out = parseResponseOutput<{
    suggestedSources: { domain: string; name: string; rationale: string }[];
  }>(response, 'discoverOutlets');

  const seen = new Set<string>();
  const sources: ProposedSource[] = [];
  for (const s of out.suggestedSources ?? []) {
    const domain = normalizeDomain(s.domain);
    if (!domain || seen.has(domain)) continue;
    seen.add(domain);
    sources.push({ domain, name: s.name.trim(), why: s.rationale.trim() });
  }
  return sources;
}

export function normalizeDomain(raw: string): string | null {
  let s = raw.trim().toLowerCase();
  s = s.replace(/^https?:\/\//, '').replace(/^www\./, '');
  const slash = s.search(/[/?#]/);
  if (slash >= 0) s = s.slice(0, slash);
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(s)) return null;
  return s;
}
