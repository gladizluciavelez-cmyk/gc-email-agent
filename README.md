# gc-email-agent

A standalone service that owns one job: read the GC's Gmail, classify each
message (subcontractor update / permit / bid invite / client / scheduling /
other), and write the results to a shared Postgres database. It's a separate
Vercel deployment from the main `gc-ai-assistant` dashboard app — its own
repo/project, own env vars, own cron schedule — decoupled on purpose so the
two can be deployed, scaled, and iterated on independently.

It is **not** a Next.js app — just plain Vercel Node serverless functions
(`api/sync.ts`), since it only needs one real endpoint.

## How it relates to gc-ai-assistant (the dashboard app)

- **Shares the same `DATABASE_URL`.** This is how the two talk to each
  other — no direct API calls between them for data, just a shared table
  (`EmailRecord`).
- **Does not own migrations.** `gc-ai-assistant` runs `prisma migrate` and is
  the source of truth for the schema. This service's `prisma/schema.prisma`
  is a trimmed, read/write subset (`User`, `Account`, `EmailRecord`) pointed
  at the same DB — kept in sync by hand if the main schema changes.
- **Does not do the Google OAuth consent flow.** That UI ("Connect Google")
  lives in the dashboard app. This service only ever reads the
  `refresh_token` NextAuth already stored on the `Account` row and uses it
  to pull mail.
- **Triggered two ways:**
  1. Its own daily cron (`vercel.json`) — bulk-syncs every user with
     `googleConnected = true`.
  2. On-demand, called server-to-server from the dashboard app's
     `/api/gmail/trigger-sync` route when someone clicks "Sync Gmail" in the
     UI (see that app's README).

## Environment variables

Copy `.env.example` to `.env.local`:

- `DATABASE_URL` — **must be the exact same database** as `gc-ai-assistant`.
- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` — same Google Cloud OAuth
  client as the dashboard app (needed to refresh access tokens from the
  stored refresh token).
- `ANTHROPIC_API_KEY`
- `CRON_SECRET` — protects the cron path. Set the same value in Vercel's
  project env vars; Vercel Cron sends it automatically as a Bearer token.
- `AGENT_SHARED_SECRET` — protects the on-demand path. Must match the value
  set in the dashboard app's env vars (it sends this header when proxying a
  "Sync now" click).

## Deploy

```bash
npm install
vercel
```

Add the env vars above in Vercel → Project → Settings → Environment
Variables, then redeploy. No `prisma migrate` step here — the tables already
exist from the dashboard app's migration.

## Scheduling note

This service's cron (`vercel.json`, `0 11 * * *` UTC by default) should run
*before* the dashboard app's daily task-planning cron, since the plan is
generated from the emails this service writes. Stagger them by 15–30 minutes
— e.g. this at 11:00 UTC, the dashboard's plan-generation cron at 11:20 UTC.
