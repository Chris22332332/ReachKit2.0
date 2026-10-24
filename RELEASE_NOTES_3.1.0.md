# ReachKit Pro 3.1.0

## Added

- Account-owned savings goals: users set their own target, saved amount, currency, optional date, and note. Goals can be edited and deleted, persist on the server, are included in account exports, and are removed with the account.
- Admin-only one-time email and SMS delivery checks. The recipient must be confirmed as yours or authorized; recipient details are not stored. Each delivery route is rate-limited to three attempts per hour per client key.
- Optional Twilio SMS adapter using `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, and `TWILIO_FROM_NUMBER`. SMS is reported unavailable until these are configured. The test message is fixed and does not support bulk sends.

## Verification

- `npm run check` — passed.
- `npm test` — passed, including account and goal isolation/deletion, capture-only SMTP test delivery, SMS consent/configuration checks, mocked Twilio request/error behavior, and prior authentication, session, analytics, upload, and conversion-webhook coverage.
- These local checks do not prove live SMTP/Twilio delivery, PostgreSQL production behavior, or a public deployment. No SMTP, Twilio, or PostgreSQL credentials were available during this build.

## Still not provided

- No social-account OAuth or automatic posting integration; platform workflows remain drafts for human review.
- No specific referral-provider integration; signed conversion reports depend on an authorized source and do not independently certify it.
- No real AI provider is active until an operator connects a provider key.
- Public launch still needs provider credentials, staging database/deployment verification, public operator/support contacts, completed privacy/terms details, backups, monitoring, and security review.
