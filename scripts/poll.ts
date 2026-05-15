/**
 * Unbubble Trails — Local Development Polling Script
 *
 * Long-polls Telegram for the Trails bot and forwards updates to the
 * local Next.js webhook endpoint so the exact same code path is exercised as
 * in production.
 *
 * Prerequisites:
 *   - `pnpm dev` running (Next.js dev server)
 *   - TELEGRAM_TRAILS_API_SECRET and TELEGRAM_TRAILS_WEBHOOK_SECRET set in
 *     .env or .env.local
 *
 * On Ctrl+C the production webhook is restored if TRAILS_WEBHOOK_URL is set;
 * otherwise the webhook is left deleted (fine for a local-only setup).
 *
 * Usage: npx tsx scripts/poll.ts [local-webhook-url]
 */

import dotenv from "dotenv";
import path from "path";

dotenv.config({ path: path.resolve(__dirname, "../.env") });
dotenv.config({ path: path.resolve(__dirname, "../.env.local") });

const BOT_TOKEN = process.env.TELEGRAM_TRAILS_API_SECRET;
const WEBHOOK_SECRET = process.env.TELEGRAM_TRAILS_WEBHOOK_SECRET;

if (!BOT_TOKEN) {
  console.error("❌ TELEGRAM_TRAILS_API_SECRET is not set in .env[.local]");
  process.exit(1);
}
if (!WEBHOOK_SECRET) {
  console.error("❌ TELEGRAM_TRAILS_WEBHOOK_SECRET is not set in .env[.local]");
  process.exit(1);
}

const LOCAL_WEBHOOK_URL =
  process.argv[2] || "http://localhost:3000/api/webhooks/trails";
const PRODUCTION_WEBHOOK_URL = process.env.TRAILS_WEBHOOK_URL;

const API_URL = `https://api.telegram.org/bot${BOT_TOKEN}`;
const POLL_TIMEOUT_SECONDS = 30;
const ALLOWED_UPDATES = ["message", "callback_query"];

let offset = 0;
let running = true;

async function deleteWebhook(): Promise<void> {
  console.log("🔌 Removing existing webhook (required for getUpdates)...");
  const res = await fetch(`${API_URL}/deleteWebhook`);
  const data = await res.json();
  if (!data.ok) {
    console.error("❌ deleteWebhook failed:", data);
    process.exit(1);
  }
  console.log("   Webhook removed.");
}

async function restoreProductionWebhook(): Promise<void> {
  if (!PRODUCTION_WEBHOOK_URL) {
    console.log(
      "ℹ️  TRAILS_WEBHOOK_URL not set — leaving the webhook deleted (local-only setup).",
    );
    return;
  }
  console.log(`🔁 Restoring production webhook: ${PRODUCTION_WEBHOOK_URL}`);
  try {
    const res = await fetch(`${API_URL}/setWebhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: PRODUCTION_WEBHOOK_URL,
        secret_token: WEBHOOK_SECRET,
        allowed_updates: ALLOWED_UPDATES,
      }),
    });
    const data = await res.json();
    if (!data.ok) {
      console.error("   ❌ setWebhook failed:", data);
      return;
    }
    console.log("   ✅ Production webhook restored.");
  } catch (err) {
    console.error(
      "   ❌ Failed to restore production webhook:",
      err instanceof Error ? err.message : err,
    );
  }
}

interface TelegramGetUpdatesResponse {
  ok: boolean;
  result?: Array<{ update_id: number; [key: string]: unknown }>;
  description?: string;
}

async function pollOnce(): Promise<void> {
  const url = `${API_URL}/getUpdates?offset=${offset}&timeout=${POLL_TIMEOUT_SECONDS}&allowed_updates=${encodeURIComponent(JSON.stringify(ALLOWED_UPDATES))}`;

  let data: TelegramGetUpdatesResponse;
  try {
    const res = await fetch(url);
    data = await res.json();
  } catch (err) {
    console.error("⚠️  getUpdates network error:", err);
    await new Promise((r) => setTimeout(r, 3000));
    return;
  }

  if (!data.ok) {
    console.error("⚠️  getUpdates error:", data.description);
    await new Promise((r) => setTimeout(r, 3000));
    return;
  }

  const updates = data.result ?? [];
  for (const update of updates) {
    offset = update.update_id + 1;
    console.log(`\n📨 Received update ${update.update_id}`);
    try {
      const res = await fetch(LOCAL_WEBHOOK_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Telegram-Bot-Api-Secret-Token": WEBHOOK_SECRET!,
        },
        body: JSON.stringify(update),
      });

      if (res.ok) {
        console.log(`   ✅ Forwarded → ${res.status}`);
      } else {
        const body = await res.text();
        console.error(`   ❌ Webhook returned ${res.status}: ${body}`);
      }
    } catch (err) {
      console.error(
        `   ❌ Failed to forward to ${LOCAL_WEBHOOK_URL}:`,
        err instanceof Error ? err.message : err,
      );
      console.error("   Is the Next.js dev server running?");
    }
  }
}

async function main(): Promise<void> {
  console.log("🤖 Unbubble Trails Bot Polling (dev mode)");
  console.log(`   Forwarding to: ${LOCAL_WEBHOOK_URL}`);
  console.log("   Press Ctrl+C to stop\n");

  await deleteWebhook();

  console.log(
    `\n👂 Polling for updates (${POLL_TIMEOUT_SECONDS}s long-poll)...\n`,
  );

  while (running) {
    await pollOnce();
  }
}

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("\n\n🛑 Stopping polling...");
  running = false;
  await restoreProductionWebhook();
  process.exit(0);
}

process.on("SIGINT", () => {
  void shutdown();
});
process.on("SIGTERM", () => {
  void shutdown();
});

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
