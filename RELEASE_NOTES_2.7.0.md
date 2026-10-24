# ReachKit Pro 2.7.0

- Added hashed, server-side account sessions that survive restarts in PostgreSQL and single-instance JSON development mode.
- Added a transactional, additive PostgreSQL migration for persistent sessions and daily page-view analytics.
- Counted public page views separately from outbound clicks. PostgreSQL counters use atomic updates; local event writes are serialized.
- Added server-side account/page export and permanent campaign deletion.
- Added server-side image dimension/pixel-count limits.
- Tightened CSRF origin matching to include scheme and made malformed cookies fail closed.
- Removed the insecure PostgreSQL `rejectUnauthorized: false` behavior.
- Replaced the hardcoded dashboard date and relabeled manual referral/reward entries as self-reported.
- Added restart, expiry, logout, concurrent click, export, deletion, and image dimension coverage to the tests.

External email verification/recovery, referral provider postbacks, and social publishing integrations still require implementation and real service credentials. See `PRODUCTION_READINESS.md`.
