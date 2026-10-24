# ReachKit Pro 2.8.0

## Account email and recovery

- Added configurable SMTP email delivery with strict TLS certificate verification.
- New accounts remain pending until the owner verifies the email address; registration does not create an authenticated session prematurely.
- Added resend verification and password recovery flows with random tokens stored only as hashes, expiry, single-use enforcement, rate limits, and session invalidation after a password reset.
- Added a capture-only email transport for isolated automated tests. It is enabled only when `NODE_ENV=test` and an explicit temporary outbox path is set.
- The server reports when mail delivery is unavailable. Signup and recovery fail with setup guidance instead of pretending an email was sent.

## Deployment and security

- Production startup requires PostgreSQL, a valid public HTTPS origin, an admin secret of at least 16 characters, and reachable SMTP settings.
- Added `/healthz` and `/readyz` endpoints and graceful SIGINT/SIGTERM shutdown.
- Added an additive migration for verified-email timestamps and expiring account tokens.
- Updated Docker to include the mail service module and updated deployment instructions for SMTP configuration.
- Replaced a real password that had appeared in `.env.example` with a placeholder. Keep secrets only in a private `.env` file or hosting secret manager.

## Limits

No real SMTP, PostgreSQL, social-platform publishing, referral conversion, or reward provider credentials were available in the build environment. These connections are configuration-dependent or unsupported and are documented in `PRODUCTION_READINESS.md`.
