# ReachKit Pro 2.9.0

## Authenticated referral-source reports

- Added an optional HMAC-SHA256 webhook receiver with a strict normalized event schema.
- Added idempotent provider event IDs and append-only status transitions for sign-up, qualification, reward, rejection, and reversal states.
- Added account-scoped report summaries and recent events. Account exports now include the account's source-reported conversion events.
- Added migration 003 for durable PostgreSQL conversion events. Existing event and campaign data is preserved; deleting a campaign cascades its events in PostgreSQL and removes the matching records in local JSON mode.
- Clearly labels reports as authenticated source data, not independently certified provider data.
- Documented the webhook contract and security setup. It only connects to providers that can send the supported HMAC format and normalized payload.

## Checks

- `npm run check` — passed.
- `npm test` — passed, including signature rejection, retry idempotency, reward totals, reversals, and cross-account privacy.
- `npm audit --omit=dev` — run for this release; see `PRODUCTION_READINESS.md`.

## Still requires external setup

No specific referral program or social platform is connected. Provider-specific postbacks, CSV formats, OAuth apps, permissions, and publication APIs require a named provider, its official interface, and authorized credentials. The webhook receiver does not invent those connections or certify a sender.
