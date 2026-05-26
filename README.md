# Unbubble Trails

A Telegram bot for following **narrow, source-curated news trails**. You describe a
topic conversationally; the bot proposes reputable outlets, previews recent matches,
and then — on a schedule — searches those sources, filters to genuinely meaningful
updates with an LLM, summarizes them, and sends you a notification.

Built with Next.js (route handlers + a Vercel cron), OpenAI, [Exa](https://exa.ai)
for news search, and Firebase Firestore for storage. Persistence sits behind a
small repository interface (`lib/repo`) so other backends can be added later.

## How it works

- **`/new`** — a conversational agent helps you define a trail: a topic
  description, a curated source list (proposed for you), and a filter rubric.
  It runs a live 7-day preview against your sources before you confirm.
- **`/trails`** — list, edit, or delete your trails.
- **Cron** — every 4 hours, each due trail is searched (Exa, restricted to its
  sources), deduped, LLM-filtered for meaningful updates, summarized, and pushed
  to you on Telegram with a cover image when one is available.

Locale follows your Telegram client language (en/it/de/es/fr).

## Requirements

- **Node.js** ≥ 18.17 (Next.js 15 baseline; 20.x recommended)
- **pnpm** 10.x (the repo pins `pnpm@10.27.0` via `packageManager`)

## Setup

```bash
pnpm install
cp .env.example .env.local   # fill in the values
```

You need: a Telegram bot token (@BotFather), an OpenAI API key, an Exa API key,
and a Firebase project with a service-account JSON (base64-encoded into
`FIREBASE_SERVICE_ACCOUNT_JSON_BASE64`).

Register the webhook + bot profile (reads `messages/*.json` for the localized
bot name/description):

```bash
pnpm setup https://your-deployment.example.com/api/webhooks/trails
```

The bot's profile picture must be set manually via @BotFather (`/setuserpic`).

## Local development

```bash
pnpm dev               # Next.js dev server on :3000
pnpm poll              # in a second shell — long-polls Telegram → localhost webhook
```

`poll.ts` deletes the production webhook while running and restores it on Ctrl+C.

## Deploy

This is a plain Next.js 15 App Router app — `next build` / `next start`, no
Vercel-only runtime APIs. It runs anywhere Next.js runs (Vercel, Render, Fly,
a VPS, Docker).

1. Set all environment variables from `.env.example` in the deployment.
2. Build and start the app (`pnpm build && pnpm start`, or your platform's
   equivalent).
3. Run `pnpm setup <prod-webhook-url>` once against the live URL.

### Cron

The cron route is `GET /api/cron/trail-notifications`, gated by a bearer
token (`CRON_SECRET`). It needs to fire roughly every 4 hours.

- **On Vercel:** `vercel.json` already registers the schedule
  `0 2,6,10,14,18,22 * * *` — six runs/day at 02/06/10/14/18/22 UTC. Vercel
  injects the `Authorization: Bearer $CRON_SECRET` header automatically when
  `CRON_SECRET` is set as a project env var. No extra work needed.
- **Anywhere else:** wire up your own scheduler (GitHub Actions on a `schedule`,
  cron-job.org, a Kubernetes CronJob, a system `crontab`, etc.) to send:

  ```
  GET https://your-host/api/cron/trail-notifications
  Authorization: Bearer <CRON_SECRET>
  ```

## Firestore setup

Collections (created automatically on first write): `trails-subscriptions`,
`trails-conversations`, `trails-notifications`.

Two things must be configured **before** the bot works end to end.

### 1. Composite indexes (required)

Two queries need composite indexes — without them the `/trails` manage list
and the cron's notification dedup will fail at runtime:

| Collection | Query | Index |
|---|---|---|
| `trails-subscriptions` | list a user's trails (`/trails`) | `telegramUserId` ASC, `createdAt` DESC |
| `trails-notifications` | recent-sent dedup (cron) | `subscriptionId` ASC, `sentAt` DESC |

These ship in [`firestore.indexes.json`](./firestore.indexes.json). Deploy them
with the Firebase CLI (one-time, ~1–2 min to build):

```bash
npm i -g firebase-tools      # if you don't have it
firebase login
firebase use <your-project-id>
firebase deploy --only firestore:indexes
```

Prefer the console? Create each index manually under **Firestore → Indexes →
Composite → Add index** using the fields in the table above. As a last resort,
the first failing query logs a `https://console.firebase.google.com/...`
one-click link in the server output — but provisioning them up front avoids a
broken first run.

(Single-field queries — `countByUser`, `listDue` — use Firestore's automatic
indexes and need no setup.)

### 2. Conversation TTL policy (recommended)

Set a **TTL policy** on `trails-conversations`, field `expiresAt`
(**Firestore → TTL → Create policy**). This garbage-collects stale
trail-creation conversations (15-min window). The code also checks `expiresAt`
lazily on read, so a missing policy only means expired docs linger in storage —
behavior is still correct.

## License

MIT — see [LICENSE](./LICENSE).
