import { createTelegramBotApi } from '@/lib/telegram/bot-api';

function getTrailsBotToken(): string {
  const token = process.env.TELEGRAM_TRAILS_API_SECRET;
  if (!token) throw new Error('TELEGRAM_TRAILS_API_SECRET is not set');
  return token;
}

/**
 * Singleton-like accessor for the Trails bot client. Each call re-binds the
 * factory; the underlying network calls are stateless so this is cheap.
 * We can't cache at module load because `.env.local` might not be loaded yet
 * at import time for some call sites.
 */
export function trailsBot() {
  return createTelegramBotApi(getTrailsBotToken());
}
