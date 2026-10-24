# ReachKit Pro 3.0.0

## Added

- Approximate unique outbound-click counts, deduplicated per campaign, browser/network fingerprint, and UTC day.
- Keyed HMAC fingerprints instead of saved raw IP addresses or browser user-agent strings.
- 30-day retention for detailed click fingerprints, with cumulative aggregate counts retained.
- A PostgreSQL migration that adds the counters and deduplication table without rewriting existing campaign data.
- Dashboard and privacy wording that explain shared-network, browser-change, and automated-preview limits.

## Deployment

- Run `npm ci` after extracting the release ZIP.
- Configure `REACHKIT_ANALYTICS_HASH_SECRET` with a stable random value of at least 32 characters in production. Keep it unchanged across deploys.
- Set `REACHKIT_TRUST_PROXY=true` only when the reverse proxy controls/overwrites `X-Forwarded-For`.
- Deploy migration 004 through the normal startup migration runner. Take a database backup first.

## Checks

`npm run check`, `npm test`, and `npm audit --omit=dev` pass in the local test environment. The test suite covers repeated-click deduplication, distinct browser fingerprints, raw user-agent non-persistence, and concurrent local click updates. A live PostgreSQL server, SMTP account, and public deployment were not available for integration checks.
