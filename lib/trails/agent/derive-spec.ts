import { localeNames, type Locale } from '@/i18n/config';
import { openai, parseResponseOutput, validateResponse } from '@/lib/ai/client';
import type { TopicQueryLanguage } from '@/lib/repo/types';

const SPEC_MODEL = 'gpt-5.4-mini' as const;
const SERVICE_TIER = 'auto' as const;
const REASONING_EFFORT = 'low' as const;

const SPEC_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    searchQuery: { type: 'string', minLength: 4, maxLength: 200 },
    queryLanguage: { type: 'string', enum: ['en', 'source'] },
  },
  required: ['searchQuery', 'queryLanguage'],
} as const;

const SPEC_SYSTEM_PROMPT = `You translate a freeform news-topic description into two fields used by the news search provider.

**searchQuery** — a short natural-language phrase (4–15 words). No boolean operators, quotes, or minus signs. Prefer entity names (people, organizations, places, laws) over generic words. Do NOT include recency words ("latest", "recent", "new", "today", "this week", "breaking"); the pipeline appends explicit date tokens at search time.

**queryLanguage**:
- "en" — topic is covered by English-language global media (politics, tech, finance, international, big sports).
- "source" — topic is primarily covered in a non-English source language (local news, regional politics, local culture). When "source", write the searchQuery in that source language.

Do not refuse. Always produce JSON.`;

export interface DerivedSpec {
  searchQuery: string;
  queryLanguage: TopicQueryLanguage;
}

/**
 * Derive searchQuery + queryLanguage from a description + locale. Cheap call,
 * no tools, structured output. Used by run_preview and finalize_trail in the
 * agent.
 */
export async function deriveSearchSpec(args: {
  description: string;
  locale: Locale;
}): Promise<DerivedSpec> {
  const response = await openai.responses.create({
    model: SPEC_MODEL,
    service_tier: SERVICE_TIER,
    reasoning: { effort: REASONING_EFFORT, summary: 'concise' },
    input: [
      { role: 'system', content: SPEC_SYSTEM_PROMPT },
      {
        role: 'user',
        content: `User's locale hint: ${localeNames[args.locale]}.\n\ntopicDescription: ${args.description}`,
      },
    ],
    text: {
      format: {
        type: 'json_schema',
        name: 'trail_search_spec',
        strict: true,
        schema: SPEC_SCHEMA,
      },
    },
  });

  validateResponse(response, 'deriveSearchSpec');
  const out = parseResponseOutput<DerivedSpec>(response, 'deriveSearchSpec');

  return out;
}
