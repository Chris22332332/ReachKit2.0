CREATE TABLE IF NOT EXISTS reachkit_x_connections (
  owner_id TEXT PRIMARY KEY REFERENCES reachkit_users(id) ON DELETE CASCADE,
  x_user_id TEXT NOT NULL,
  username TEXT NOT NULL,
  display_name TEXT NOT NULL,
  access_token_encrypted TEXT NOT NULL,
  refresh_token_encrypted TEXT NOT NULL DEFAULT '',
  expires_at BIGINT NOT NULL,
  connected_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS reachkit_x_posts (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES reachkit_users(id) ON DELETE CASCADE,
  x_post_id TEXT NOT NULL UNIQUE,
  username TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS reachkit_x_posts_owner_created_idx ON reachkit_x_posts(owner_id,created_at DESC);
