# Deployment, migrations, backup, and rollback

## Required production setup

1. Deploy this folder as the repository root. Use Node.js 20 or newer.
2. Provision PostgreSQL and set `DATABASE_URL` to the provider’s private connection string. For a public/TLS endpoint, set `DATABASE_SSL=require` (or `verify-full`) and add the provider CA path with `DATABASE_SSL_CA` if it is not in the runtime trust store. The app normalizes `sslmode` from the URL so it cannot silently disable certificate checks. Production startup rejects `DATABASE_SSL=disable`.
3. Set `NODE_ENV=production`, `HOST=0.0.0.0`, the hosting provider’s `PORT`, and `PUBLIC_BASE_URL` to the exact public HTTPS origin.
4. Set `REACHKIT_ADMIN_PASSWORD` to a unique secret with at least 16 characters. Set `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, optional `SMTP_USER`/`SMTP_PASSWORD`, and `EMAIL_FROM` for your transactional email provider. Use port 465 with `SMTP_SECURE=true`, or a STARTTLS port such as 587 with `SMTP_SECURE=false`. ReachKit verifies SMTP connectivity at production startup and keeps TLS certificate validation enabled.
5. Set `REACHKIT_ANALYTICS_HASH_SECRET` to a stable random secret of at least 32 characters. This key protects daily-rotating analytics fingerprints and must stay the same across deploys. If hosting behind a reverse proxy that overwrites/controls `X-Forwarded-For`, set `REACHKIT_TRUST_PROXY=true`; otherwise leave it false. Never trust forwarded headers from an untrusted proxy/client.
6. Configure a persistent data volume and `REACHKIT_DATA_DIR` if the legacy admin AI-provider settings and `/join` page must survive redeploys. Account sessions, accounts, referral pages, uploaded cover bytes, views, clicks, and approximate unique click totals use PostgreSQL when `DATABASE_URL` is configured. Production startup fails closed if PostgreSQL, the public HTTPS origin, the admin secret, the analytics key, or SMTP is missing.
7. Optionally set `REACHKIT_CONVERSION_WEBHOOK_SECRET` to a random secret of at least 32 characters if an authorized source can send the normalized signed webhook described below.
8. Build with `npm ci --omit=dev` and start with `npm start`.

Never commit `.env`, database URLs, provider API keys, data directories, or database dumps. The included `.env.example` contains placeholders only.

## Database migrations

On startup, ReachKit creates the existing base tables if needed, then applies numbered SQL files from `migrations/` that are not present in `reachkit_schema_migrations`. Each migration runs in a transaction and is recorded only after it succeeds. Migrations 001–006 add persistent sessions, page views, email recovery, append-only conversion webhook events, approximate unique-click counters/fingerprints, account-owned savings goals, and X connection/post history. The unique fingerprint table expires detailed fingerprints after 30 days; goal and account data are not deleted by upgrades.

Approximate unique click analytics process the request IP address and browser user-agent transiently, then store only an HMAC fingerprint scoped to campaign and UTC date. Fingerprints expire after 30 days; aggregate totals remain. The dashboard labels this as a browser/network-day estimate because shared networks, browser changes, and automated previews prevent this from representing verified individual people. For a trusted hosting proxy, configure `REACHKIT_TRUST_PROXY=true` only if it overwrites/controls the forwarded address header.

Take a provider snapshot or `pg_dump` backup before deployment. Test a restore into a separate database before relying on the backup. Do not edit a migration that has already run in production; add a new numbered migration instead.

## Backup and restore

Use your database provider’s managed backup where available. A manual PostgreSQL backup can be made with `pg_dump --format=custom --file=reachkit-before-deploy.dump "$DATABASE_URL"`. Restore to a new database first with `pg_restore --clean --if-exists --no-owner --dbname="$RESTORE_DATABASE_URL" reachkit-before-deploy.dump`, then validate the app against that restored database. Keep the original database untouched until the restored copy is checked.

The local JSON mode needs a consistent copy of the entire `REACHKIT_DATA_DIR`, including `users.json`, `campaigns.json`, `sessions.json`, and `uploads/`. It is intended for development or a single persistent instance, not multi-instance production.

## Account email

New accounts remain pending until the user verifies the address. Verification links expire after 24 hours. Password reset links expire after 30 minutes, are single-use, and invalidate existing sessions. ReachKit stores only a hash of each token. SMTP settings use `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, optional `SMTP_USER` and `SMTP_PASSWORD`, and `EMAIL_FROM`. Set `PUBLIC_BASE_URL` so email links always point to the deployed HTTPS site. The app does not print tokens or email contents to logs.

After unlocking admin settings, the owner can send a fixed one-time email test to an address they control. Optional SMS tests use `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, and an authorized E.164 `TWILIO_FROM_NUMBER`. Enter the test number in Settings and confirm that it is yours or you have permission. Recipients are not saved. Each test route is limited to three sends per hour per client key; these are not bulk messaging features. Configure Twilio sender registration and messaging policy for your region. Provider acceptance does not confirm inbox or carrier delivery.

## X publishing

X publishing is optional and currently supports text-only posts after the signed-in user explicitly confirms each post. Create an X developer app with OAuth 2.0 enabled and the scopes `tweet.write users.read offline.access`. Register an exact callback URL ending in `/api/social/x/callback`. Set `PUBLIC_BASE_URL`, `X_CLIENT_ID`, optional `X_CLIENT_SECRET` for a confidential app, `X_REDIRECT_URI`, and a stable 32-byte `REACHKIT_TOKEN_ENCRYPTION_KEY`. Generate a key, for example with PowerShell: `[Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))`. Keep it in the host's secret manager; changing it makes existing encrypted tokens unreadable. X API posting may incur pay-per-use charges; check current X pricing before connecting. OAuth tokens are encrypted at rest and are not included in account exports.

Use `/healthz` for process liveness and `/readyz` for readiness. The readiness route checks PostgreSQL when configured; production mode requires PostgreSQL.

## Signed conversion source reports

ReachKit accepts a provider-neutral webhook only when `REACHKIT_CONVERSION_WEBHOOK_SECRET` is configured. This is useful only when an authorized source or your authorized integration service can sign the exact request body with HMAC-SHA256 and send the `x-reachkit-signature: sha256=<lowercase hex>` header. The signature covers the exact UTF-8 JSON bytes. ReachKit does not independently certify that the sender is the referral program, so the account dashboard labels these as authenticated source reports. Do not call them provider-verified unless the configured sender is the provider itself and its setup is authorized.

Send `POST /api/webhooks/conversions` with JSON shaped like:

```json
{"provider":"my-referral-program","eventId":"provider-event-123","conversionId":"referral-abc","campaignSlug":"my-offer","status":"qualified","occurredAt":"2026-10-20T12:00:00Z"}
```

Allowed states are `signup`, `qualified`, `rewarded`, `rejected`, and `reversed`. Use a new stable `eventId` for each state change and the same `conversionId` for the referral. A `rewarded` event may include both `rewardAmount` and a three-letter `currency`; other states may not include a reward amount. Repeated events with the same provider and event ID are safely ignored. The latest event per conversion controls the current dashboard state, so later reversals remove it from active totals.

To calculate the signature in an authorized integration service, use the HMAC-SHA256 function in that service's crypto library over the exact serialized body. Never put the webhook secret in a browser, public repository, referral URL, or log. If the referral program cannot send this format or expose an authorized export/API, this endpoint cannot produce real data for that program.

## Rollback

For a code-only rollback after the additive migration, redeploy the previous application revision while retaining the database. The old revision ignores the added columns and tables. If a future migration is not backward compatible, stop writes, restore the pre-deploy snapshot into a separate database, verify it, then point the previous revision to that restored database. Never overwrite the only copy of production data during rollback.

## External services and unsupported integrations

Email verification and password recovery need a real email service. Owner SMS tests need a Twilio account and sender. X publishing is the only social platform with an optional direct integration; all other platform workflows remain drafts/manual publish. Official referral-program API adapters are not included. The optional signed receiver stores authenticated source reports, but it is not itself an integration to any specific referral program and does not independently verify the sender. AI provider requests require a provider account and API key configured in ReachKit Settings; the built-in generator is not live AI. The app does not claim to certify rewards.
