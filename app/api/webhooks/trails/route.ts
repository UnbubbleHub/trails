import { after, type NextRequest } from 'next/server';
import type { TelegramUpdate } from '@/lib/telegram/types';
import { dispatchTrailsUpdate } from '@/lib/trails/dispatcher';

export const dynamic = 'force-dynamic';
// The webhook returns 200 immediately and finishes the dispatch in `after()`.
// Keep the function alive long enough for an agent turn / send to complete.
export const maxDuration = 300;

/**
 * POST /api/webhooks/trails
 *
 * Webhook for the Unbubble Trails Telegram bot. Accepts both `message` and
 * `callback_query` updates. Always returns 200 to prevent Telegram retries.
 */
export async function POST(request: NextRequest) {
  try {
    const secretHeader = request.headers.get('x-telegram-bot-api-secret-token');
    const expectedSecret = process.env.TELEGRAM_TRAILS_WEBHOOK_SECRET;
    if (!expectedSecret || secretHeader !== expectedSecret) {
      console.error('[Trails] Webhook secret mismatch');
      return new Response('OK', { status: 200 });
    }

    const update = (await request.json()) as TelegramUpdate;

    after(dispatchTrailsUpdate(update));

    return new Response('OK', { status: 200 });
  } catch (error) {
    console.error('[Trails] Webhook handler error:', error);
    return new Response('OK', { status: 200 });
  }
}
