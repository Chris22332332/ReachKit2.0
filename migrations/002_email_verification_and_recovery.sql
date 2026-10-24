-- Additive account ownership verification and single-use password recovery tokens.
ALTER TABLE reachkit_users ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ;
CREATE TABLE IF NOT EXISTS reachkit_auth_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES reachkit_users(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL CHECK (purpose IN ('verify-email', 'reset-password')),
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS reachkit_auth_tokens_user_purpose_idx ON reachkit_auth_tokens(user_id, purpose);
CREATE INDEX IF NOT EXISTS reachkit_auth_tokens_expiry_idx ON reachkit_auth_tokens(expires_at);
