import { NextResponse } from 'next/server';
import { getRepo } from '@/lib/repo';
import { safeCompare } from '@/lib/safe-compare';
import { runSubscriptionNotifications } from '@/lib/trails/notify';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const BATCH_SIZE = Number(process.env.TOPIC_CRON_MAX_SUBS_PER_RUN ?? 40);
const CONCURRENCY = 5;
const GLOBAL_BUDGET_MS = 270_000;

/**
 * Cron: for each subscription whose `nextCheckDue` has elapsed, fetch new
 * search matches, run the "meaningful update" filter, summarize, and notify
 * via the Trails Telegram bot.
 */
export async function GET(request: Request) {
  const authHeader = request.headers.get('Authorization');
  const token = authHeader?.replace('Bearer ', '') ?? '';
  const expectedToken = process.env.CRON_SECRET ?? '';
  if (!token || !expectedToken || !safeCompare(expectedToken, token)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const now = new Date();
  const deadline = now.getTime() + GLOBAL_BUDGET_MS;

  let checked = 0;
  let notified = 0;
  let skipped = 0;
  let errors = 0;

  try {
    const subs = await getRepo().subscriptions.listDue(now, BATCH_SIZE);
    console.log(`[TrailsCron] Processing ${subs.length} due subscriptions`);

    const queue = [...subs];
    const workers: Promise<void>[] = [];

    for (let i = 0; i < CONCURRENCY; i++) {
      workers.push(
        (async () => {
          while (queue.length > 0) {
            if (Date.now() >= deadline) {
              console.warn('[TrailsCron] global deadline reached; stopping worker');
              return;
            }
            const sub = queue.shift();
            if (!sub) return;
            try {
              const result = await runSubscriptionNotifications(sub);
              checked++;
              notified += result.notifiedCount;
              if (result.skipped) skipped++;
              if (result.error) errors++;
            } catch (err) {
              errors++;
              console.error(`[TrailsCron] fatal for sub ${sub.id}:`, err);
            }
          }
        })()
      );
    }

    await Promise.all(workers);

    return NextResponse.json({
      success: true,
      checked,
      notified,
      skipped,
      errors,
      remaining: queue.length,
    });
  } catch (err) {
    console.error('[TrailsCron] error:', err);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
