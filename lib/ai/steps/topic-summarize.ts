import type { Locale } from '@/i18n/config';
import { localeNames } from '@/i18n/config';
import { openai, parseResponseOutput, validateResponse } from '../client';

const MODEL = 'gpt-5.4-mini' as const;
const SERVICE_TIER = 'auto' as const;
const REASONING_EFFORT = 'low' as const;

export interface RecentSent {
  headline: string;
  summary: string;
  publishedAt: string | null;
}

export type TopicSummary =
  | {
      meaningful: true;
      headline: string;
      summary: string;
      eventDateIso: string | null;
      selectedCoverUrl: string | null;
      coverRejectReason: string | null;
    }
  | {
      meaningful: false;
      skipReason: string;
      eventDateIso: string | null;
      selectedCoverUrl: null;
      coverRejectReason: string | null;
    };

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    meaningful: { type: 'boolean' },
    skipReason: { type: 'string', maxLength: 200 },
    headline: { type: 'string', maxLength: 120 },
    summary: { type: 'string', maxLength: 280 },
    eventDateIso: {
      type: 'string',
      description:
        'YYYY-MM-DD of the most recent substantive event the article reports on, derived from the article body (not from publishedAt). Empty string if not determinable from the body.',
      maxLength: 10,
    },
    selectedCoverIndex: {
      type: ['integer', 'null'],
      description:
        'Index into the provided coverCandidates array of the chosen cover image, or null if none of the candidates is good enough (or no candidates were provided).',
    },
    coverRejectReason: {
      type: 'string',
      description:
        'Empty string when a cover was selected. Short reason when selectedCoverIndex is null, e.g. "all candidates are generic logos".',
      maxLength: 200,
    },
  },
  required: [
    'meaningful',
    'skipReason',
    'headline',
    'summary',
    'eventDateIso',
    'selectedCoverIndex',
    'coverRejectReason',
  ],
} as const;

function buildSystemPrompt(locale: Locale): string {
  return `You write concise, neutral summaries of news articles for a Telegram push notification delivered to a user who is already subscribed to a specific topic.

OUTPUT LANGUAGE — HARD REQUIREMENT: Headline and summary MUST be written in ${localeNames[locale]}, ALWAYS, regardless of the article's source language. The article may be in Polish, Japanese, Arabic, or any other language — translate it into ${localeNames[locale]}. Never pass through source-language content. Keep proper nouns (people, places, organizations) in their original form, but the connective and descriptive prose around them must be in ${localeNames[locale]}.

You also act as a final gate: you have access to the article's "text" — a relevance snippet followed by the full article body in markdown, joined by a blank line — plus a short history of notifications already sent for the same topic AND the user's structured topic spec ("topicDescription" + "filterRubric"). The body may be truncated. An earlier filter already pre-screened candidates from titles + the snippet against the same rubric — but with the full body in hand you may discover the article does not actually satisfy the rubric, or is not a meaningful update. In that case, reject it.

When applying the gate, consult both inputs:
- "filterRubric" — the structured INCLUDE / EXCLUDE / Core entities / Event types checklist. **This is your primary criterion.** Walk the article body against each bullet; an article must satisfy at least one INCLUDE, violate none of the EXCLUDE, involve a core entity (when listed), and report a listed event type (when listed). If "filterRubric" is empty, fall back to "topicDescription" alone.
- "topicDescription" — supporting prose context for ambiguous cases.

A meaningful update reports substantive new information: a new decision, ruling, vote, statement, data release, investigation, escalation, primary-source document, or first-hand incident report — something that meaningfully advances the reader's understanding beyond what's already in "recentSent".

Always set "eventDateIso": the YYYY-MM-DD date of the most recent substantive event the article reports on. Derive it from the article body, not from "publishedAt" — the search source's published date is occasionally unreliable (republished/syndicated/aggregated content gets a fresh timestamp even when the underlying event is old). Use internal date references in the body ("on Tuesday", "last month", "20 aprile", "in 2023", "earlier this year") and resolve them against "now". If the body has no usable date reference and you can't confidently place the event, set it to "" (empty string). A downstream code check enforces a hard freshness threshold against this field — be honest. Don't paper over an old event with today's date to push the article through; an honest "" or correct old date is better than a fabricated recent one.

Reject (set meaningful=false, fill skipReason with a short justification, leave headline and summary empty — but still set eventDateIso to your best estimate from the body):
- Anything that fails the rubric check above (off-topic, missing core entities, wrong event type, or matches an EXCLUDE bullet).
- Duplicates or near-duplicates of anything in "recentSent" — same facts, same angle, no new development.
- Restatements, summaries, or roundups of older news.
- Opinion, analysis, or commentary that doesn't add new facts.
- Listicles or generic explainers that merely mention the topic.
- Speculative/rumor pieces without named sources.
- Articles that repeat known facts without advancing the story.
- Republished, recycled, or evergreen pieces about old events.

Be conservative: if you can't point to something specific AND recent that's new vs. recentSent, reject. It's better to send nothing than to send noise.

When meaningful=true, set skipReason to "" and write the headline + summary as follows:

Context assumption:
- The reader knows they are receiving this because it matches their topic subscription. The topic title is already shown in the message header above your output. DO NOT restate or prefix the topic in the headline or summary — it would be redundant. Focus on what's new or specific in this article.
- Good headline (topic = "Pope Leo's pastoral visit to Africa"): "Message to young people on colonialism".
- Bad headline (same topic): "Pope Leo in Africa: message to young people on colonialism" — the "Pope Leo in Africa" prefix just repeats the topic.

Style — short, catchy, precise. Aim for the cadence of a well-edited Italian newsletter (think Il Post). Concrete, plainspoken, conversational; no bureaucratese, no clickbait, no editorializing.

Headline:
- ≤ 90 characters. Aim for ~50–70. Shorter is better when it still says something specific.
- One concrete fact, in the present tense or simple past. Vivid, narrative, but factually exact.
- It can name a place, an actor, or the event itself — whatever is most striking and specific. Don't lead with the topic's central actor/event if that's already implied by the subscription.
- No colons-as-prefix ("X: Y"), no quotes, no hype words, no ALL CAPS, no emojis, no question marks.

Summary:
- 1 sentence, ≤ 180 characters. Two short sentences only if truly necessary.
- It does NOT restate the headline. It continues from the headline — adding the missing piece a curious reader needs: cause, consequence, context, scale, who's affected, what happens next.
- Often starts with a connector that flows from the headline ("It's…", "That is…", "While…", "Even though…", "After…", "He was referring to…", "It was…", "And…", "Including…"). Use this pattern when it fits naturally; don't force it.
- Plain, declarative, neutral. No editorializing. No emojis.

Examples of the target style (the same voice applies in any language):
- Headline: "Iran is running out of places to store its oil" / Summary: "It's a consequence of the US naval blockade, and could force the regime to suspend production"
- Headline: "The United Arab Emirates will leave OPEC" / Summary: "That is, the organization of the world's largest oil-exporting countries: it has to do with the war in the Middle East"
- Headline: "In Colombia, attacks by armed groups are the most intense in years" / Summary: "Even though president Gustavo Petro had promised to pacify the country, and elections are a month away"
- Headline: "A clandestine bank was uncovered in Padua" / Summary: "It was set up behind a Chinese restaurant, had surveillance cameras and even a sort of accountant: 12 people have been arrested"
- Headline: "The systematic exploitation of resident doctors in hospitals" / Summary: "The latest case, reported in Verona, is similar to many others, with shifts past legal limits and duties outside their role"
- Headline: "A new lawsuit against Michael Jackson" / Summary: "After defending him for years, four brothers have said they were sexually abused as children, and are seeking damages"

Notice: the headline gives the news; the summary gives the angle. Together they read as one tight thought. Never repeat information across the two.

Rules:
- Headline and summary in ${localeNames[locale]} (see OUTPUT LANGUAGE above — non-negotiable). Keep proper nouns in their original form.
- Do not invent facts that aren't in the article. If the article is vague, keep the summary vague too.

Cover image selection:
You may also receive zero or more candidate cover images, each labeled "Cover candidate 0", "Cover candidate 1", etc. and shown to you as image inputs. Your job is to pick the best one for a Telegram push notification — or reject all of them.

- If candidates are provided, set "selectedCoverIndex" to the integer index of the best candidate, or null if none are good enough.
- If no candidates are provided, set "selectedCoverIndex" to null.
- When you select a cover, set "coverRejectReason" to "". When you return null, set "coverRejectReason" to a short reason (e.g. "all are generic logos", "all are unrelated stock photos", "only candidate is a paywall promo"). The reason is for telemetry only — be terse.

Reject a candidate when it is:
- A generic site logo, publication wordmark, favicon-style mark, or default placeholder ("image not available", silhouette).
- A stock photo with no clear connection to the headline or article.
- Pixelated, heavily compressed, or visibly low-quality.
- Mostly text — a front-page screenshot, a typography-heavy social card, or an infographic with tiny print.
- A paywall, subscription, ad, or promotional overlay graphic.
- An author headshot when the story is not about that person.
- Misleading: implies something the article does not claim.
- Graphic, NSFW, or otherwise unsuitable for a push notification.

Accept a candidate when the image visually anchors the story without misleading.

Be conservative — when in doubt, return null. No cover is a fine outcome; a bad cover is worse than no cover. If multiple candidates are acceptable, prefer the one that most concretely depicts the news (the people, place, object, or event named in the headline) over a generic but topical photo.

The image may also be substantive evidence for the article itself — if the article is *about* a photo (a leaked image, a viral photograph, a satellite shot), use what you see in the image to inform the headline and summary. Don't invent details from images that aren't the subject of the story.`;
}

export async function summarizeArticle(args: {
  locale: Locale;
  /** The subscription's topic title — passed so the model knows what context the reader already has and avoids repeating it. */
  topicTitle: string;
  /** Subscription's prose description — supporting context for the final gate. */
  topicDescription: string;
  /** Subscription's structured filter rubric — primary criterion for the final gate. Empty string allowed. */
  filterRubric: string;
  /** Recent notifications already sent for this subscription — the model rejects candidates that don't advance these. */
  recentSent: RecentSent[];
  title: string;
  url: string;
  text: string;
  /** The article's published date as reported by the search source — may be unreliable, the model cross-checks against body content. */
  publishedAt: string | null;
  /**
   * URLs of cover-image candidates that survived format/size pre-filtering, in
   * priority order. The model picks the best one (or rejects all of them) and
   * also uses the images as additional evidence for the summary itself.
   */
  coverCandidates?: string[];
}): Promise<TopicSummary> {
  const nowIso = new Date().toISOString();
  const candidates = args.coverCandidates ?? [];

  const articlePayload = JSON.stringify({
    now: nowIso,
    topicTitle: args.topicTitle,
    topicDescription: args.topicDescription,
    filterRubric: args.filterRubric,
    recentSent: args.recentSent,
    article: {
      title: args.title,
      url: args.url,
      publishedAt: args.publishedAt,
      text: args.text,
    },
    coverCandidateCount: candidates.length,
  });

  const userContent: Array<
    { type: 'input_text'; text: string } | { type: 'input_image'; image_url: string; detail: 'low' }
  > = [{ type: 'input_text', text: articlePayload }];

  for (let i = 0; i < candidates.length; i++) {
    userContent.push({ type: 'input_text', text: `Cover candidate ${i}:` });
    userContent.push({
      type: 'input_image',
      image_url: candidates[i],
      detail: 'low',
    });
  }

  const response = await openai.responses.create({
    model: MODEL,
    service_tier: SERVICE_TIER,
    reasoning: { effort: REASONING_EFFORT, summary: 'concise' },
    input: [
      { role: 'system', content: buildSystemPrompt(args.locale) },
      { role: 'user', content: userContent },
    ],
    text: {
      format: {
        type: 'json_schema',
        name: 'topic_summary',
        strict: true,
        schema: SCHEMA,
      },
    },
  });

  validateResponse(response, 'summarizeArticle');
  const out = parseResponseOutput<{
    meaningful: boolean;
    skipReason: string;
    headline: string;
    summary: string;
    eventDateIso: string;
    selectedCoverIndex: number | null;
    coverRejectReason: string;
  }>(response, 'summarizeArticle');

  const eventDateIso = out.eventDateIso.trim() === '' ? null : out.eventDateIso.trim();

  const selectedCoverUrl =
    out.selectedCoverIndex !== null &&
    Number.isInteger(out.selectedCoverIndex) &&
    out.selectedCoverIndex >= 0 &&
    out.selectedCoverIndex < candidates.length
      ? candidates[out.selectedCoverIndex]
      : null;
  const coverRejectReason =
    selectedCoverUrl === null
      ? out.coverRejectReason.trim() === ''
        ? null
        : out.coverRejectReason.trim()
      : null;

  if (!out.meaningful) {
    return {
      meaningful: false,
      skipReason: out.skipReason,
      eventDateIso,
      selectedCoverUrl: null,
      coverRejectReason,
    };
  }
  return {
    meaningful: true,
    headline: out.headline,
    summary: out.summary,
    eventDateIso,
    selectedCoverUrl,
    coverRejectReason,
  };
}
