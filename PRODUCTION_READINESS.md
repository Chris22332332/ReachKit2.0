# ReachKit Pro 3.2.0 production-readiness report

## Verified in this workspace

- Account signup requires a configured mail service, creates a pending server account, sends a tokenized verification email, and does not create an authenticated session before verification.
- Email verification tokens are random, hashed at rest, expire after 24 hours, and are single-use. Password reset tokens are hashed, expire after 30 minutes, are single-use, and invalidate existing sessions when used.
- SMTP delivery is configurable and uses TLS certificate verification. Production startup requires PostgreSQL, an HTTPS public origin, a 16-character admin secret, and a reachable SMTP transport. Configuration failures are reported without echoing secrets.
- `/healthz` and `/readyz` endpoints are implemented. SIGINT/SIGTERM shutdown closes the HTTP server and PostgreSQL pool gracefully.
- Existing tests still cover account ownership, public pages, image checks, analytics, account export/deletion, persistent sessions, and drafting guardrails.
- Approximate unique click counts now deduplicate keyed browser/network fingerprints per campaign and UTC day. Raw IP addresses and user-agent values are not stored by this feature; detailed fingerprints expire after 30 days. Local JSON updates are serialized and PostgreSQL increments use a transaction with a uniqueness constraint.
- Users can create, list, edit, and delete up to 20 account-owned personal savings goals. The balance and target are user-entered, explicitly self-reported values; they persist in JSON development mode or PostgreSQL production mode, are included in account export, and are removed with account deletion.
- Admin-only fixed email and SMS delivery tests are implemented. Tests require destination permission confirmation, are limited to three attempts per hour per client key, never save the recipient, and distinguish provider acceptance from final delivery. Twilio settings are optional; SMS stays unavailable when they are missing.
- X OAuth 2.0 PKCE connection, AES-256-GCM encrypted server-side access/refresh tokens, account identity lookup, token refresh, explicit per-post approval, X text publishing, and account-owned post history are implemented. Provider calls have mocked unit tests; they do not verify an X app or live account.
- `npm run check` passes. `npm test` covers account, token expiry/replay, session restart/logout, multi-user isolation, owned savings-goal CRUD/export/deletion, no-email-config gating, capture-only email tests, SMS consent/configuration and mocked provider behavior, X PKCE/token encryption/refresh/post request behavior with a mock provider, signed conversion events, HMAC rejection, deduplication, reversals, and report isolation. The test SMTP transport writes only to a temporary local test outbox.
- `npm audit --omit=dev` reports zero vulnerabilities for the production dependency tree at the time of the check.
- The example environment file contains placeholders; the operator’s private password must be kept in `.env` or the hosting secret manager.

## Not verified or not implemented

- No real SMTP account was provided. Test mode validates message generation and flow behavior but does not prove delivery, domain authentication, spam placement, provider quotas, or the real provider's availability.
- No Twilio credentials or registered sender were provided. The mocked service tests verify request formatting and error handling, but no real SMS was sent and carrier delivery was not verified.
- No X developer app, client credentials, approved scopes, registered callback, or encryption secret were provided. No live OAuth connection or public post was tested. Only text posts are supported; scheduled and media posting are not implemented. X API calls may cost money.
- No PostgreSQL server or database credentials were available. Migrations 001–006 and PostgreSQL paths still need execution against a staging PostgreSQL database and restart/restore testing.
- An optional generic HMAC-SHA256 webhook now stores idempotent source-reported signup, qualification, reward, rejection, and reversal events. No specific referral program is connected, and ReachKit cannot independently certify the configured sender. Provider-verified results remain unavailable until an authorized program integration is configured and tested.
- X publishing is implemented but only works after operator configuration and user authorization. Other social platforms remain manual drafts. No live connection was tested.
- Page views and outbound clicks include repeat activity and automated previews. The new unique-click value is an approximate browser/network-day estimate: shared networks can combine people, browser/network changes can split a person's activity, and automated previews can count. It is not a unique-person or referral-conversion measure.
- Live AI provider calls were not made because no AI credentials were supplied. Built-in drafting is labeled as local mode.
- The deployed HTTPS site, external preview crawlers, production mail, and a full device/accessibility browser review were not available for validation.
- Privacy and terms pages still need the real operator name/contact, data retention practices, and jurisdiction-specific review. Support and abuse-reporting workflows are not implemented.

## Launch blockers

Before inviting real users, configure PostgreSQL, public HTTPS, SMTP, an admin secret, backups, monitoring, support and abuse contacts, and accurate legal pages. Test mail delivery to addresses you control. Run all migrations on a staging database, test concurrent requests and restore from backup, then deploy to staging and exercise registration, verification, reset, page publication, image previews, and deletion. Do not describe click counts or generic signed reports as verified referrals or rewards unless the source is authorized and independently established.

Real conversion tracking and social publishing depend on each provider's documented API, program authorization, and credentials. X text publishing is implemented, but remains unavailable until the operator configures an X developer app and users authorize it. Other social platforms remain manual-review workflows. No specific referral program is connected.

## Checks run

- `npm run check` — passed after the v3.2 X publishing and browser asset updates.
- `npm test` — passed with repeated-click deduplication, distinct browser fingerprints, absence of stored raw user-agent strings, concurrent local click counts, generated verification/reset/test email flows, email-not-configured gating, SMS consent and mocked-provider checks, X OAuth PKCE/token encryption/refresh/post request behavior with a mock provider, token expiry/replay rejection, multi-user privacy, goal lifecycle/export/deletion, persistent session restart/logout/expiry, HMAC webhook verification, duplicate rejection, reversal totals, and per-account event privacy.
- `npm audit --omit=dev` — passed with 0 reported vulnerabilities for the production dependency tree at the time of the check.

Tests use isolated temporary JSON storage and a local capture-only mail transport. They do not seed production accounts or prove real SMTP delivery, PostgreSQL migration/query behavior, or an internet-hosted deployment. The production analytics secret and trusted-proxy setting also need to be set correctly in the hosting environment.
