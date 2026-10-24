-- Additive only: preserves existing campaign data and introduces persistent sessions + view metrics.
ALTER TABLE reachkit_campaigns ADD COLUMN IF NOT EXISTS image_data BYTEA;
ALTER TABLE reachkit_campaigns ADD COLUMN IF NOT EXISTS views BIGINT NOT NULL DEFAULT 0;
ALTER TABLE reachkit_campaigns ADD COLUMN IF NOT EXISTS daily_views JSONB NOT NULL DEFAULT '{}'::jsonb;
CREATE TABLE IF NOT EXISTS reachkit_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES reachkit_users(id) ON DELETE CASCADE,
  expires_at BIGINT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS reachkit_sessions_user_idx ON reachkit_sessions(user_id);
