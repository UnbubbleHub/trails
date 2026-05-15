/**
 * Retry utility for Firestore operations with exponential backoff.
 * Handles transient network errors like TLS disconnects, timeouts, etc.
 */

/** Error patterns that indicate transient failures worth retrying */
const RETRYABLE_ERROR_PATTERNS = [
  'UNAVAILABLE',
  'DEADLINE_EXCEEDED',
  'RESOURCE_EXHAUSTED',
  'ECONNRESET',
  'ETIMEDOUT',
  'socket disconnected',
  'socket hang up',
  'TLS connection',
  'ENOTFOUND',
  'EAI_AGAIN',
  'network socket disconnected',
];

/**
 * Checks if an error is retryable (transient network/service error).
 * Checks both error.message and error.code for Node.js system errors.
 */
function isRetryableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  // Also check error.code for Node.js system errors (ECONNRESET, ETIMEDOUT, etc.)
  const code =
    error instanceof Error && 'code' in error ? String((error as { code?: unknown }).code) : '';

  return RETRYABLE_ERROR_PATTERNS.some((pattern) => {
    const lowerPattern = pattern.toLowerCase();
    return (
      message.toLowerCase().includes(lowerPattern) || code.toLowerCase().includes(lowerPattern)
    );
  });
}

/**
 * Delays execution for a specified number of milliseconds.
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface RetryOptions {
  /** Maximum number of retries (default: 3) */
  maxRetries?: number;
  /** Base delay in ms for exponential backoff (default: 1000) */
  baseDelayMs?: number;
  /** Context string for logging (e.g., function name) */
  context?: string;
}

/**
 * Wraps an async operation with retry logic and exponential backoff.
 * Only retries on transient errors (network issues, service unavailable, etc.).
 *
 * @param operation - The async operation to execute
 * @param options - Retry configuration options
 * @returns The result of the operation
 * @throws The last error if all retries are exhausted
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const { maxRetries = 3, baseDelayMs = 1000, context = 'operation' } = options;

  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;

      // Don't retry non-retryable errors
      if (!isRetryableError(error)) {
        throw error;
      }

      // Don't retry if we've exhausted all attempts
      if (attempt === maxRetries) {
        console.error(
          `[Firestore Retry] ${context}: All ${maxRetries} retries exhausted`,
          error instanceof Error ? error.message : error
        );
        throw error;
      }

      // Calculate exponential backoff delay
      const delayMs = baseDelayMs * Math.pow(2, attempt);
      console.warn(
        `[Firestore Retry] ${context}: Attempt ${attempt + 1} failed, retrying in ${delayMs}ms`,
        error instanceof Error ? error.message : error
      );

      await delay(delayMs);
    }
  }

  // This should never be reached, but TypeScript needs it
  throw lastError;
}

/**
 * Non-blocking retry wrapper for logging operations.
 * Retries once on failure, then logs error and continues.
 * Never throws - designed for fire-and-forget logging.
 *
 * @param operation - The async logging operation
 * @param context - Context string for error logging
 */
export async function withNonBlockingRetry<T>(
  operation: () => Promise<T>,
  context: string
): Promise<void> {
  try {
    await operation();
  } catch (firstError) {
    // Check if it's a retryable error
    if (isRetryableError(firstError)) {
      console.warn(
        `[Firestore Retry] ${context}: First attempt failed, retrying once`,
        firstError instanceof Error ? firstError.message : firstError
      );

      // Wait 1 second before retry
      await delay(1000);

      try {
        await operation();
      } catch (secondError) {
        // Log and continue - never throw
        console.error(
          `[Firestore Retry] ${context}: Retry failed, giving up`,
          secondError instanceof Error ? secondError.message : secondError
        );
      }
    } else {
      // Non-retryable error - just log it
      console.error(
        `[Firestore Retry] ${context}: Non-retryable error`,
        firstError instanceof Error ? firstError.message : firstError
      );
    }
  }
}
