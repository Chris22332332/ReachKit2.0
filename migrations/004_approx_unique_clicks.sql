ALTER TABLE reachkit_campaigns ADD COLUMN IF NOT EXISTS unique_clicks BIGINT NOT NULL DEFAULT 0;
ALTER TABLE reachkit_campaigns ADD COLUMN IF NOT EXISTS daily_unique_clicks JSONB NOT NULL DEFAULT '{}'::jsonb;
CREATE TABLE IF NOT EXISTS reachkit_unique_click_fingerprints (
  campaign_id TEXT NOT NULL REFERENCES reachkit_campaigns(id) ON DELETE CASCADE,
  event_day DATE NOT NULL,
  fingerprint TEXT NOT NULL,
  PRIMARY KEY (campaign_id,event_day,fingerprint)
);
CREATE INDEX IF NOT EXISTS reachkit_unique_click_fingerprints_day_idx ON reachkit_unique_click_fingerprints(event_day);
