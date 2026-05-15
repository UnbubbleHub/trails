/**
 * Performs a constant-time string comparison to prevent timing attacks.
 *
 * WHY THIS MATTERS:
 * Regular string comparison (===) returns false as soon as it finds a mismatch.
 * An attacker can measure response times to guess secrets character-by-character:
 * - "a..." fails instantly (wrong first char)
 * - "s..." takes slightly longer (first char matches, fails on second)
 * - "se..." takes even longer
 * ...and so on until they crack the secret.
 *
 * This function ALWAYS checks every character, taking the same time regardless
 * of where (or if) a mismatch occurs. This makes timing attacks impractical.
 *
 * @param secret - The expected secret value
 * @param input - The user-provided value to compare
 * @returns true if the strings match exactly, false otherwise
 */
export function safeCompare(secret: string, input: string): boolean {
  if (secret.length !== input.length) return false;

  let result = 0;
  for (let i = 0; i < secret.length; i++) {
    // XOR the character codes. If they match, XOR produces 0.
    // OR accumulates any non-zero result, so a single mismatch makes result non-zero.
    // Crucially, we ALWAYS iterate through every character.
    result |= secret.charCodeAt(i) ^ input.charCodeAt(i);
  }

  return result === 0;
}
