import { openai, parseResponseOutput, validateResponse } from '../client';

const MODEL = 'gpt-5.4-mini' as const;
const SERVICE_TIER = 'auto' as const;
const REASONING_EFFORT = 'low' as const;

export interface MeaningfulCandidate {
  searchId: string;
  title: string;
  url: string;
  publishedAt: string | null;
  /** Short query-relevance snippet from the search provider. */
  snippet: string;
  /**
   * First few hundred chars of the article body, truncated by the caller.
   * Empty string when the provider didn't return one. Cheap signal for the
   * pre-screen — e.g. lead paragraph clearly marks an article as a
   * recap/op-ed even when the title looks newsy.
   */
  bodyExcerpt: string;
}

export interface RecentSent {
  headline: string;
  summary: string;
  publishedAt: string | null;
}

export interface MeaningfulPick {
  searchId: string;
  rationale: string;
}

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    meaningful: {
      type: 'array',
      maxItems: 3,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          searchId: { type: 'string' },
          rationale: { type: 'string', maxLength: 300 },
        },
        required: ['searchId', 'rationale'],
      },
    },
  },
  required: ['meaningful'],
} as const;

const SYSTEM_PROMPT = `You decide which new candidate news items are meaningful updates on a user's topic, given a short history of notifications already sent for the same topic.

Each candidate carries a "title", a short "snippet" (the search provider's relevance excerpt — usually 1–2 sentences), and a "bodyExcerpt" (the first ~400 chars of the article body, when available). The bodyExcerpt is your strongest cheap signal: lead paragraphs reliably mark recap/explainer/opinion pieces and newswire syndication that the title alone hides. Read it before deciding. It may be empty for some candidates — fall back to title + snippet in that case.

You receive three topic-context fields:
- "filterRubric" — a structured plaintext checklist with INCLUDE bullets, EXCLUDE bullets, Core entities, and Event types. **This is your primary criterion.** Walk each candidate against it: a candidate matches only if it satisfies at least one INCLUDE bullet, violates none of the EXCLUDE bullets, involves at least one core entity (when listed), and is one of the listed event types (when listed).
- "topicDescription" — a 1–3 sentence prose description of the topic. Use it as supporting context when the rubric is ambiguous.
- If "filterRubric" is empty, fall back to "topicDescription" as the sole criterion.

On top of the rubric, a candidate is meaningful only if it reports substantive new information: a new decision, ruling, vote, statement, data release, investigation, escalation, primary-source document, or first-hand incident report — something that meaningfully advances the reader's understanding.

Reject:
- Anything that fails the rubric check above.
- Duplicates or near-duplicates of anything in "recentSent".
- Restatements, summaries, or roundups of older news.
- Opinion pieces, analysis, or commentary that doesn't add new facts.
- Listicles that merely mention the topic.
- Speculative/rumor pieces without named sources.
- Articles that repeat known facts without advancing the story.
- High level articles that cover the whole topic generically.

Deduplicate within the candidate set. News is widely syndicated and aggregated — multiple candidates often report the same underlying event under different titles, URLs, or domains. If two or more candidates describe the same decision, ruling, statement, incident, or release, return at most ONE of them: the most authoritative and comprehensive (prefer primary sources and original reporting over aggregators/syndicators when the substance is identical). Do not return multiple variants of the same story.

Be conservative. It's better to send nothing this hour than to send noise. Return at most 3 items, each covering a distinct underlying event, ranked by importance.`;

export async function pickMeaningfulUpdates(args: {
  topicDescription: string;
  /** Structured filter rubric. Empty string is allowed — the prompt falls back to `topicDescription` in that case. */
  filterRubric: string;
  recentSent: RecentSent[];
  candidates: MeaningfulCandidate[];
  maxPicks: number;
}): Promise<MeaningfulPick[]> {
  if (args.candidates.length === 0) return [];

  const response = await openai.responses.create({
    model: MODEL,
    service_tier: SERVICE_TIER,
    reasoning: { effort: REASONING_EFFORT, summary: 'concise' },
    input: [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: JSON.stringify({
          topicDescription: args.topicDescription,
          filterRubric: args.filterRubric,
          recentSent: args.recentSent,
          candidates: args.candidates,
        }),
      },
    ],
    text: {
      format: {
        type: 'json_schema',
        name: 'meaningful_updates',
        strict: true,
        schema: SCHEMA,
      },
    },
  });

  validateResponse(response, 'pickMeaningfulUpdates');
  const out = parseResponseOutput<{ meaningful: MeaningfulPick[] }>(
    response,
    'pickMeaningfulUpdates'
  );

  return out.meaningful.slice(0, Math.max(0, args.maxPicks));
}
