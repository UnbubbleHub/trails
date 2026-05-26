/**
 * Unbubble Trails — Telegram Bot Webhook & Profile Registration Script
 *
 * Usage: pnpm setup <webhook-url>
 *   e.g. pnpm setup https://your-deployment.example.com/api/webhooks/trails
 *
 * The webhook URL may also be supplied via the TRAILS_WEBHOOK_URL env var.
 *
 * Registers:
 *   - The Telegram webhook for the Trails bot
 *   - The bot's command list (/new, /trails, /help, /cancel)
 *   - The bot's name + short + long descriptions, in all supported locales
 *     (sourced from messages/{en,it,de,es,fr}.json under `trails.botProfile`).
 *
 * Reads TELEGRAM_TRAILS_API_SECRET and TELEGRAM_TRAILS_WEBHOOK_SECRET
 * from ../.env and ../.env.local.
 *
 * Note: the bot's profile picture is NOT settable via the Bot API — it must
 * be set manually through @BotFather (`/setuserpic`).
 */

import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../.env') });
dotenv.config({ path: path.resolve(__dirname, '../.env.local') });

const BOT_TOKEN = process.env.TELEGRAM_TRAILS_API_SECRET;
const WEBHOOK_SECRET = process.env.TELEGRAM_TRAILS_WEBHOOK_SECRET;

if (!BOT_TOKEN) {
  console.error('❌ TELEGRAM_TRAILS_API_SECRET is not set in .env[.local]');
  process.exit(1);
}
if (!WEBHOOK_SECRET) {
  console.error('❌ TELEGRAM_TRAILS_WEBHOOK_SECRET is not set in .env[.local]');
  process.exit(1);
}

const WEBHOOK_URL = process.argv[2] || process.env.TRAILS_WEBHOOK_URL;
if (!WEBHOOK_URL) {
  console.error(
    '❌ No webhook URL. Pass it as an argument:\n' +
      '   pnpm setup https://your-deployment.example.com/api/webhooks/trails\n' +
      '   (or set TRAILS_WEBHOOK_URL in .env.local)'
  );
  process.exit(1);
}

const API_URL = `https://api.telegram.org/bot${BOT_TOKEN}`;

// English is the default (no language_code); the rest are localized variants.
const DEFAULT_LOCALE = 'en';
const OTHER_LOCALES = ['it', 'de', 'es', 'fr'] as const;

type BotProfile = {
  name: string;
  shortDescription: string;
  longDescription: string;
};

function loadBotProfile(locale: string): BotProfile {
  const messagesPath = path.resolve(__dirname, `../messages/${locale}.json`);
  const raw = fs.readFileSync(messagesPath, 'utf8');
  const messages = JSON.parse(raw);
  const profile = messages?.trails?.botProfile;
  if (!profile?.name || !profile?.shortDescription || !profile?.longDescription) {
    throw new Error(`Missing trails.botProfile keys in ${locale}.json`);
  }
  return profile;
}

async function callBotApi(
  method: string,
  payload: Record<string, unknown>
): Promise<{ ok: boolean; description?: string }> {
  const res = await fetch(`${API_URL}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return res.json();
}

async function setProfileForLocale(locale: string | null, profile: BotProfile): Promise<void> {
  const langSuffix = locale ? ` (${locale})` : ' (default)';
  const langPayload = locale ? { language_code: locale } : {};

  const calls: Array<[string, string, Record<string, unknown>]> = [
    ['setMyName', 'name', { name: profile.name, ...langPayload }],
    [
      'setMyShortDescription',
      'short description',
      { short_description: profile.shortDescription, ...langPayload },
    ],
    [
      'setMyDescription',
      'long description',
      { description: profile.longDescription, ...langPayload },
    ],
  ];

  for (const [method, label, payload] of calls) {
    const data = await callBotApi(method, payload);
    if (data.ok) {
      console.log(`   ✅ ${label}${langSuffix}`);
    } else {
      // Telegram silently rejects updates if the new value equals the current
      // one (description "...is exactly the same as a current..."). Treat as
      // info, not an error.
      const desc = data.description ?? '(no description)';
      const sameValue = /same as a current/.test(desc);
      const prefix = sameValue ? 'ℹ️' : '⚠️';
      console.log(`   ${prefix} ${label}${langSuffix}: ${desc}`);
    }
  }
}

async function main() {
  console.log(`\n📡 Setting webhook to: ${WEBHOOK_URL}`);
  const setRes = await callBotApi('setWebhook', {
    url: WEBHOOK_URL,
    secret_token: WEBHOOK_SECRET,
    allowed_updates: ['message', 'callback_query'],
  });
  if (!setRes.ok) {
    console.error('❌ setWebhook failed:', setRes);
    process.exit(1);
  }
  console.log('✅ Webhook set successfully');

  console.log('\n📋 Registering bot commands...');
  const cmdRes = await callBotApi('setMyCommands', {
    commands: [
      { command: 'new', description: 'Follow a new trail' },
      { command: 'trails', description: 'Manage your trails' },
      { command: 'help', description: 'Show help information' },
      { command: 'cancel', description: 'Cancel the current flow' },
    ],
  });
  if (!cmdRes.ok) {
    console.error('❌ setMyCommands failed:', cmdRes);
  } else {
    console.log('✅ Bot commands registered');
  }

  console.log('\n👤 Updating bot profile (name + descriptions) in all locales...');
  // Default first (no language_code) then each localized variant.
  await setProfileForLocale(null, loadBotProfile(DEFAULT_LOCALE));
  for (const locale of OTHER_LOCALES) {
    await setProfileForLocale(locale, loadBotProfile(locale));
  }
  console.log(
    '\nℹ️  Profile picture is not settable via the Bot API — set it manually via @BotFather (/setuserpic).'
  );

  console.log('\n🔍 Verifying webhook info...');
  const infoRes = await fetch(`${API_URL}/getWebhookInfo`);
  const infoData = await infoRes.json();
  if (infoData.ok) {
    const info = infoData.result;
    console.log(`   URL: ${info.url}`);
    console.log(`   Allowed updates: ${JSON.stringify(info.allowed_updates)}`);
    console.log(`   Pending update count: ${info.pending_update_count}`);
    if (info.last_error_message) {
      console.log(`   ⚠️ Last error: ${info.last_error_message}`);
    }
  }

  console.log('\n✅ Done!');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
