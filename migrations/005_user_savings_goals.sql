CREATE TABLE IF NOT EXISTS reachkit_savings_goals (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES reachkit_users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  target_amount NUMERIC(14,2) NOT NULL CHECK(target_amount > 0),
  current_amount NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK(current_amount >= 0),
  currency CHAR(3) NOT NULL DEFAULT 'USD',
  target_date DATE,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS reachkit_savings_goals_owner_created_idx ON reachkit_savings_goals(owner_id,created_at DESC);
