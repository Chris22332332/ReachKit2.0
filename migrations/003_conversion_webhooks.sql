-- Append-only, idempotent webhook events. These are authenticated source reports,
-- not independently certified by ReachKit; keep the source/provider visible.
CREATE TABLE IF NOT EXISTS reachkit_conversion_events (
  provider TEXT NOT NULL,
  event_id TEXT NOT NULL,
  campaign_id TEXT NOT NULL REFERENCES reachkit_campaigns(id) ON DELETE CASCADE,
  conversion_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('signup','qualified','rewarded','rejected','reversed')),
  reward_amount NUMERIC(14,2),
  currency CHAR(3),
  occurred_at TIMESTAMPTZ NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(provider,event_id)
);
CREATE INDEX IF NOT EXISTS reachkit_conversion_events_campaign_idx ON reachkit_conversion_events(campaign_id,occurred_at DESC);
CREATE INDEX IF NOT EXISTS reachkit_conversion_events_conversion_idx ON reachkit_conversion_events(provider,conversion_id,occurred_at DESC);
