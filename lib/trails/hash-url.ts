import { createHash } from 'crypto';

/** Canonical URL hash used for dedup. Lowercase origin + path + search, no fragment. */
export function hashUrl(url: string): string {
  let canonical = url;
  try {
    const u = new URL(url);
    u.hash = '';
    u.hostname = u.hostname.toLowerCase();
    canonical = u.toString();
  } catch {
    // leave as-is
  }
  return createHash('sha1').update(canonical).digest('hex');
}
