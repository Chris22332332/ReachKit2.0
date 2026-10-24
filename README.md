# ReachKit Pro 3.2.0 — account-owned goals, delivery checks, and reviewed X publishing

ReachKit is a referral workspace with user accounts, personal goal tracking, browser-local drafts, server-backed referral pages, and optional direct X publishing. Version 3.2 adds X OAuth 2.0 PKCE account connections and user-confirmed text posts, with encrypted token storage and post history. Version 3.1 adds account-owned savings goals and admin-only one-time email/SMS delivery tests. Version 3.0 adds approximate unique click counts using daily-rotating keyed fingerprints. Version 2.9 adds optional signed, idempotent conversion-source reports with rejection/reversal handling and account-scoped reporting. Version 2.8 added SMTP-backed email verification and password recovery, expiring single-use tokens, production configuration checks, health/readiness routes, and graceful shutdown.

## What is real in this release

- Account signup sends a verification email before sign-in is allowed. Password recovery sends a single-use reset link. Both flows require a configured SMTP service; no email is claimed as sent when delivery is unavailable.
- Admin can send a fixed, one-time email or SMS test to a destination they control. SMS uses Twilio when configured; recipient details are not saved. These tools do not send referral campaigns, bulk messages, or unsolicited outreach.
- A signed-in user can connect an X account with OAuth 2.0 PKCE and publish one reviewed text post at a time after explicit confirmation. Tokens are AES-256-GCM encrypted in server storage. An X developer app, callback, and 32-byte encryption key are required; provider/API charges may apply.
- Passwords are stored as salted scrypt hashes, not plain text. Verification/reset tokens are random, stored only as hashes, expire, and are single-use.
- Each account can publish up to 30 distinct referral pages. Each page has an owner, a unique custom slug, a title, campaign name, accurate details, and an HTTPS destination URL.
- The share URL looks like `https://your-domain.example/r/my-referral-offer`. The page renders on the server so preview bots can read its title, description, canonical URL, Open Graph image, and Twitter large-image card before running JavaScript.
- A user can upload a PNG, JPG, or WebP image up to 3 MB. The browser crops it to a landscape 1200 × 630 cover; with PostgreSQL configured, the image bytes are stored in the database with the campaign. Otherwise, they are stored under `REACHKIT_DATA_DIR/uploads`.
- The public landing page visibly shows the cover, offer details, referral disclosure, official destination domain, and a button linking to the original referral URL. It does not hide the destination behind an opaque redirect.
- A click on the official-destination button updates aggregate and daily counts. The dashboard also estimates unique browser/network clicks per UTC day by storing keyed fingerprints for at most 30 days; it never stores raw addresses or user-agent strings as analytics records. Shared networks and browser changes make this an approximation, and automated previews can count. Click counts are not verified sign-ups, eligible referrals, or proof of rewards.
- An optional HMAC-signed webhook accepts normalized events from an authorized source, rejects invalid signatures, deduplicates event IDs, and applies later reversals. Dashboard counts are labeled as authenticated source reports because ReachKit cannot independently certify who controls the signing secret.
- An account only sees and edits its own pages. Users can unpublish pages and delete their own account, server pages, uploads, and click totals.
- Each signed-in user can create up to 20 personal savings goals with their own name, target, currency, current self-reported balance, target date, and note. Goals are stored server-side, isolated by account, editable/deletable, and included in account export. ReachKit does not connect to banks or independently verify balances.
- Account sessions are server-side, stored as token hashes, and survive restarts. PostgreSQL mode uses database sessions; single-instance JSON development mode stores sessions in its data directory.
- Production startup requires PostgreSQL, an HTTPS `PUBLIC_BASE_URL`, a long admin secret, and a reachable configured SMTP service. `/healthz` and `/readyz` are available for host health checks. X publishing remains unavailable until the operator configures an X developer app, callback, and stable token-encryption key.
- Referral page views and outbound clicks are separate counters. PostgreSQL uses atomic updates and deduplicated fingerprint records; local JSON writes are serialized within one process. Approximate unique counts can combine people on shared networks or count the same person more than once across browsers/networks. They are not unique people or conversions.
- Signed-in users can export server-side account/page data and permanently delete an individual page.
- Privacy and terms starter pages are provided at `/privacy.html` and `/terms.html`. The operator must complete and review them before inviting the public.
- The legacy multi-platform draft workspace, built-in writer, optional server-side AI providers, requested-link reply builder, results tracker, and older `/join` publishing flow are retained.

## What this does not fake

ReachKit does not sign other people into an account, create accounts on referral providers, automate qualifying actions, alter reward balances, or guarantee points. Each public page links to the actual HTTPS referral destination and tells visitors to check current eligibility and provider terms. X is the only direct social publishing integration in this release; all other platforms remain drafts for manual review and publishing. X requires per-post confirmation; bulk posting and direct messaging are not enabled.

## Human-sounding AI posts (version 2.6)

The live AI provider is still supported. The generated prompt now uses the exact app / offer name, supplied reward details, your goal for the post, your preferred voice, audience, platform and destination as context. It asks for natural conversational copy, short sentences, a simple call to action, and just one brief referral disclosure. It specifically tells the model not to guess the program name, add unsupported reward numbers, invent personal experience, pad the draft with legal caveats, or confuse the referral offer with another app such as TikTok Shop.

The output cleaner removes clearly unsupported currency / point claims, recurring TT Shop / TikTok Shop mentions unless those names were actually supplied, boilerplate warnings, duplicate disclosures, duplicate links, and excessive output. It keeps the exact referral URL and one truthful referral disclosure. As with all model output, review every draft before sharing.

In **Campaign setup**, fill in:
- **Exact app / offer name:** the exact label shown by the program, such as `TT Pro` only if that is the real name of your offer.
- **What do you want the post to get across?:** write instructions for the AI, e.g. “Explain the real steps, invite interested people to use my link, keep it short and casual, and do not call this TT Shop.”
- **How do you normally talk?:** e.g. “simple, casual, a little slang, not formal or salesy.”

If the dashboard shows **AI API ON**, the live provider uses these instructions. If it shows **BUILT-IN**, no live model is connected: the simpler local writer works without a key but cannot follow nuanced free-form instructions the way a language model can. Connect and test a provider in Settings to use the full AI. API usage may cost money; check the provider account’s terms and limits.

## Run and test locally

Requirements: Node.js 20 or newer.

1. Extract the project ZIP. `package.json`, `server.js`, and `public/` should be at the project root.
2. Copy `.env.example` to a new private `.env` file. Keep the example file unchanged and never commit `.env`.
3. Run `npm ci` once. The PostgreSQL driver is required for database mode.
4. Run `npm run check`, then `npm test`.
5. To use account signup locally, configure SMTP settings in `.env`, then run `npm start` and open `http://127.0.0.1:3000`.

With no `DATABASE_URL`, account/campaign data is stored in JSON files in `./data` and uploaded images in `./data/uploads`. That local fallback is useful for development, but production startup requires PostgreSQL and will stop with a setup message if it is missing.

## Recommended Render deployment for a real shared site

**Use a Render Web Service plus a PostgreSQL database.** A free Render Web Service has an ephemeral filesystem, so account JSON, uploaded files, and saved files can vanish after restarts/redeploys. Render's free PostgreSQL database currently expires after 30 days, so use a database plan with the required retention for a lasting public site. See the official Render notes below.

1. Push the *contents* of this project folder to your existing GitHub repository. Confirm `package.json` and `server.js` are at repository root. Do not commit `.env`, `data/`, database URLs, or API keys.
2. In Render, open your existing **Web Service**. Keep the same service and deploy branch so it updates the existing website.
3. Create or attach a Render PostgreSQL database. Copy its **internal/private connection string** into the Web Service environment variable `DATABASE_URL`. The project creates its account and campaign tables on startup. If you use a different database host, use that provider's private/appropriate connection string and TLS instructions.
4. Set these Web Service environment variables:

   - `NODE_ENV=production`
   - `HOST=0.0.0.0`
   - `DATABASE_URL` = your database connection string
   - `DATABASE_SSL=require` when the database provider requires external TLS; certificate verification remains enabled. Set `DATABASE_SSL_CA` to a CA PEM path only when the provider requires a custom CA.
   - `PUBLIC_BASE_URL=https://YOUR-REAL-SERVICE.onrender.com` (use your exact public HTTPS origin, without a trailing slash; replace the example)
   - `REACHKIT_ADMIN_PASSWORD` = a unique secret with at least 16 characters for the legacy AI settings and `/join` controls
   - `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD`, and `EMAIL_FROM` = your real transactional email provider's SMTP settings
   - Optional X publishing: `X_CLIENT_ID`, optional private `X_CLIENT_SECRET`, exact `X_REDIRECT_URI=https://YOUR-REAL-SERVICE.onrender.com/api/social/x/callback`, and `REACHKIT_TOKEN_ENCRYPTION_KEY` (32 random bytes encoded as base64). Register the same callback URL in X's developer console and enable `tweet.write`, `users.read`, and `offline.access`.
   - Optional SMS test: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, and authorized `TWILIO_FROM_NUMBER`.

   Keep `PORT` set by Render. Do not put secrets in GitHub or send them in a chat.
5. Use Build Command `npm ci` and Start Command `npm start`. Startup checks SMTP connectivity and runs additive database migrations.
6. Open your site over HTTPS, register a test address you control, verify the email, reset the password, and publish a non-sensitive test page. Check `/healthz`, `/readyz`, its cover, and click count.
7. Before announcing the site, complete the privacy/terms pages and provide support and abuse-reporting contacts. Email delivery is implemented but was not tested against your real provider here.

Render docs: [Persistent disks](https://render.com/docs/disks), [free instance limits](https://render.com/docs/free), [environment variables](https://render.com/docs/configure-environment-variables), and [web services](https://render.com/docs/web-services).

### Important storage detail

When `DATABASE_URL` is set, PostgreSQL stores the accounts, public campaign fields, uploaded image bytes, page publication state, and click counts. Older features—like global AI-provider configuration in `data/ai-providers.json` and the legacy single `/join` page—still use the local data directory. If you want those legacy settings to survive Render redeploys too, attach a persistent disk to a plan that supports it and set `REACHKIT_DATA_DIR` to that disk's mount path; otherwise those legacy settings may need to be re-entered after a restart. Do not try to use a paid-only disk mount on a free service.

Set `PUBLIC_BASE_URL` accurately: it is used to generate absolute `og:image` and canonical URLs. Social platforms cache link previews, sometimes after the page changes, so use the platform's preview refresh/debugger when a new image does not appear immediately. The image's URL must be publicly reachable without a login. The default cover is included at `/og-default.png`.

## AI writing providers

AI is optional. The built-in writer works without a key. The current provider list supports Google Gemini, OpenRouter, Groq, Cerebras, Mistral AI, Hugging Face Router, OpenAI, Anthropic Claude, DeepSeek, Together AI, Fireworks AI, xAI, and Cohere. Provider settings remain private behind the legacy admin unlock and keys are not returned by public provider-list responses. In production, the shared server-side AI draft endpoint requires a signed-in ReachKit account or the admin session and is rate-limited. If you enable shared provider keys for a public website, watch provider billing, quotas, and usage rules carefully; API credits may be chargeable.

## Security and current limitations

This is a functional release, **not a fully audited public SaaS**. SMTP-backed verification/recovery and X publishing code are implemented, but real mail, Twilio, X app, and PostgreSQL services still require operator configuration and staging verification. Only X supports direct publishing; other platforms remain manual. No particular referral program is connected, so the app cannot verify rewards without a separately authorized source. Moderation/reporting and a support contact workflow are not implemented. JSON mode is only for one development instance. Use HTTPS, PostgreSQL, backups, unique admin credentials, completed legal pages, and an independent security review before public promotion. Uploaded covers and published referral pages are public by design; do not upload private images or sensitive details.

The account-backed public pages are server-stored. Ordinary drafting workspace state, platform destinations, and draft edits remain in browser `localStorage`; they do not sync between devices. The account export endpoint includes server-side account and page data. Use **Settings → Export data** for the separate browser-local workspace backup.

See [PRODUCTION_READINESS.md](PRODUCTION_READINESS.md) for exactly what was verified and what still blocks a public launch. See [DEPLOYMENT.md](DEPLOYMENT.md) for migrations, PostgreSQL backup/restore, TLS configuration, and rollback.

For platforms and referral providers, verify their current rules. A community destination being present in ReachKit is not permission to post there. Do not spam, mass-post near-duplicates, send unsolicited DMs, bypass eligibility requirements, or claim guaranteed rewards. Click counts may include repeat clicks or automated previews; only the referral provider can confirm qualifying sign-ups and credit rewards.

## Main project files

- `server.js` — app server, account sessions, password hashing, PostgreSQL or JSON storage, campaign routing, uploaded image serving, social metadata, click counters, legacy publishing, and AI endpoints
- `drafting.js` — contextual prompt builder, concise-output rules, unsupported-claim cleanup, and referral-disclosure normalization
- `email-service.js` — SMTP delivery with TLS certificate verification and isolated test outbox mode
- `public/index.html` — dashboard, account, and campaign forms
- `public/app.js` — workspace behavior, account UX, campaign form, file crop/preview, campaign cards, and share link controls
- `public/styles.css` — responsive dashboard and public page editor
- `public/og-default.png` — default 1200 × 630 social cover
- `public/privacy.html` / `public/terms.html` — starter policy pages to review before public launch
- `.env.example` — configuration names without real secrets
- `Dockerfile` — container deployment scaffold
- `test/smoke.js` — API and feature smoke tests
