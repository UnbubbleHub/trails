import { localeNames, type Locale } from '@/i18n/config';
import { openai, parseResponseOutput, validateResponse } from '@/lib/ai/client';

const MODEL = 'gpt-5.4-mini' as const;
const SERVICE_TIER = 'auto' as const;
const REASONING_EFFORT = 'low' as const;

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    stories: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          primaryIndex: { type: 'integer', minimum: 0 },
          duplicateIndices: {
            type: 'array',
            items: { type: 'integer', minimum: 0 },
          },
          headline: { type: 'string', maxLength: 140 },
        },
        required: ['primaryIndex', 'duplicateIndices', 'headline'],
      },
    },
  },
  required: ['stories'],
} as const;

function buildPrompt(args: { locale: Locale; topicDescription: string }): string {
  return `You receive a batch of raw news article titles + snippets that matched a user's news topic subscription. Two jobs:

1. **Cluster duplicates.** When multiple articles report the SAME underlying event (even with different angles, different publishers, different phrasings of the headline), group them into one story. Two articles are duplicates if a reasonable reader would say "yes, that's the same news story." When in doubt, keep them separate.

2. **Rewrite each unique story's headline** as a notification-style headline in ${langueName(args.locale)}.

The user's topic is:
"${args.topicDescription}"

Output \`stories\`: one entry per unique event.
- \`primaryIndex\` — index of the most representative input article (prefer the most recently published; tie-break with the most reputable publisher).
- \`duplicateIndices\` — zero or more other input indices that report the same event. Empty array if the story is unique.
- \`headline\` — rewritten in ${langueName(args.locale)}, following these rules:
  - Concise, factual, neutral — no clickbait, no sensationalism, no exclamation marks, no editorializing adjectives.
  - 4–14 words. No trailing punctuation.
  - Do NOT restate the user's topic. The topic is shown above; focus on what's new or specific in this article.
  - Strip publisher names, dates, "BREAKING:", emoji, and "—" prefixes commonly tacked onto SEO headlines.
  - Translate from the source language if needed. Keep proper nouns (people, places, organizations) in their original form.
  - If the snippet contradicts or clarifies the raw title, prefer what the snippet says.

Every input index must appear in exactly one story (either as primaryIndex or in duplicateIndices). Do not skip inputs. Do NOT refuse.`;
}

function langueName(locale: Locale): string {
  return localeNames[locale];
}

export interface PolishInput {
  index: number;
  rawTitle: string;
  snippet: string;
  domain: string | null;
  publishedAt: string | null;
}

export interface PolishedStory {
  primaryIndex: number;
  duplicateIndices: number[];
  headline: string;
}

/**
 * One LLM call that both clusters near-duplicate events and rewrites each
 * cluster's headline in the user's locale in a uniform notification style.
 */
export async function dedupeAndPolishPreviewItems(args: {
  inputs: PolishInput[];
  locale: Locale;
  topicDescription: string;
}): Promise<PolishedStory[]> {
  if (args.inputs.length === 0) return [];

  const userPayload = args.inputs.map((i) => ({
    index: i.index,
    rawTitle: i.rawTitle.slice(0, 200),
    snippet: i.snippet.slice(0, 400),
    domain: i.domain,
    publishedAt: i.publishedAt,
  }));

  const response = await openai.responses.create({
    model: MODEL,
    service_tier: SERVICE_TIER,
    reasoning: { effort: REASONING_EFFORT, summary: 'concise' },
    input: [
      {
        role: 'system',
        content: buildPrompt({ locale: args.locale, topicDescription: args.topicDescription }),
      },
      { role: 'user', content: JSON.stringify(userPayload) },
    ],
    text: {
      format: {
        type: 'json_schema',
        name: 'dedupe_and_polish_preview',
        strict: true,
        schema: SCHEMA,
      },
    },
  });

  validateResponse(response, 'dedupeAndPolishPreviewItems');
  const out = parseResponseOutput<{ stories: PolishedStory[] }>(
    response,
    'dedupeAndPolishPreviewItems'
  );

  return out.stories ?? [];
}
