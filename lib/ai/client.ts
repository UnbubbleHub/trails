import OpenAI from 'openai';

// ============================================================================
// Client
// ============================================================================

let _openai: OpenAI | null = null;

function getOpenAI(): OpenAI {
  if (_openai) return _openai;
  _openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    timeout: 15 * 60 * 1000, // 15 min — flex service tier can queue longer
  });
  return _openai;
}

/**
 * Lazily-constructed OpenAI client. The constructor throws when no API key is
 * present, so we defer it until first use — `next build` imports route modules
 * without invoking handlers and must not require credentials.
 */
export const openai: OpenAI = new Proxy({} as OpenAI, {
  get(_target, prop, receiver) {
    const client = getOpenAI();
    const value = Reflect.get(client as object, prop, receiver);
    return typeof value === 'function' ? value.bind(client) : value;
  },
});

// ============================================================================
// Response Handling Utilities
// ============================================================================

/**
 * Validates an OpenAI response and throws if it failed or was incomplete.
 */
export function validateResponse(response: OpenAI.Responses.Response, operationName: string): void {
  if (response.status === 'failed') {
    throw new Error(response.error?.message ?? `${operationName} failed`);
  }
  if (response.status === 'incomplete') {
    const reason = response.incomplete_details?.reason ?? 'unknown';
    throw new Error(`${operationName} was truncated (reason: ${reason})`);
  }
}

/**
 * Extracts and parses the output text from an OpenAI response.
 * Throws if no output is present.
 */
export function parseResponseOutput<T>(
  response: OpenAI.Responses.Response,
  operationName: string
): T {
  const outputText = response.output_text;
  if (!outputText) {
    throw new Error(`No output from ${operationName}`);
  }
  return JSON.parse(outputText) as T;
}
