# ReachKit Pro 3.2.0

## Added

- Optional X OAuth 2.0 PKCE account connection and user-approved text posting. Provider tokens are encrypted at rest with AES-256-GCM; account-owned post history is retained. Requires operator-supplied X app configuration and a stable 32-byte encryption key.
- Cache-versioned CSS and JavaScript asset URLs so updated releases do not keep using stale browser assets.
- A global hidden-state CSS rule so controls marked `hidden` remain hidden even when component styles define their layout.
- X service tests for OAuth authorization, code exchange, encrypted tokens, account lookup, post creation, token refresh, and sanitized provider errors.

## Limits

- Only X has a direct social publishing integration, and only text posts are supported. Every post requires explicit confirmation. Other platforms remain manual drafts.
- No SMTP, Twilio, X developer app, or PostgreSQL credentials were configured for this verification run. No real email, SMS, or social post was sent.
- No specific referral program is connected. Referral outcomes and rewards are not verified by ReachKit.
- `npm run check`, `npm test`, and `npm audit --omit=dev` passed in the working copy. See [PRODUCTION_READINESS.md](PRODUCTION_READINESS.md) for remaining staging and launch requirements.
