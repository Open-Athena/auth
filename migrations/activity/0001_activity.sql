-- Optional independent migration track. Requires transactional D1 batch().
CREATE TABLE activity_kinds (
  kind TEXT PRIMARY KEY,
  record TEXT NOT NULL CHECK (record IN ('off', 'count', 'line')),
  notify TEXT NOT NULL CHECK (notify IN ('off', 'count', 'line')),
  CHECK (notify = 'off' OR record = 'line' OR (record = 'count' AND notify = 'count'))
);

CREATE TABLE activity_bursts (
  id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL,
  actor_name TEXT NOT NULL,
  via TEXT NOT NULL,
  origin TEXT NOT NULL,
  first_ts INTEGER NOT NULL,
  last_ts INTEGER NOT NULL,
  received_ts INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 0,
  purging INTEGER NOT NULL DEFAULT 0 CHECK (purging IN (0, 1))
);
CREATE INDEX activity_bursts_actor ON activity_bursts(actor_id, origin, last_ts DESC, id DESC);
CREATE INDEX activity_bursts_received ON activity_bursts(purging, received_ts);

-- Count-only rows are replay receipts, not detailed events. Dedupe lasts until purge.
CREATE TABLE activity_events (
  id TEXT PRIMARY KEY,
  burst_id TEXT NOT NULL REFERENCES activity_bursts(id),
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,
  record TEXT NOT NULL CHECK (record IN ('count', 'line')),
  notify TEXT NOT NULL CHECK (notify IN ('off', 'count', 'line')),
  line TEXT,
  path TEXT,
  session_id TEXT,
  CHECK (record = 'line' OR (line IS NULL AND path IS NULL AND session_id IS NULL))
);
CREATE INDEX activity_events_burst ON activity_events(burst_id, ts, id);

CREATE TABLE activity_posts (
  burst_id TEXT NOT NULL REFERENCES activity_bursts(id),
  sink TEXT NOT NULL,
  message_id TEXT,
  version INTEGER NOT NULL DEFAULT 0,
  claim_token TEXT,
  claim_until INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (burst_id, sink)
);
