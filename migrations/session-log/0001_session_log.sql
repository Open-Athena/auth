-- The optional session log (`@open-athena/auth/session-log`), a migration
-- track of its own: apply it only on deployments that mount the session log.
-- Additive, no foreign keys (so the retention purge can delete in any order).
-- disky's `session_log*` tables are this schema already.

CREATE TABLE IF NOT EXISTS session_log (
  sid         TEXT PRIMARY KEY,
  email       TEXT,
  via         TEXT,
  build       TEXT,
  ua          TEXT,
  started_ms  INTEGER NOT NULL,
  last_ms     INTEGER NOT NULL,
  n_events    INTEGER NOT NULL,
  n_errors    INTEGER NOT NULL,
  n_batches   INTEGER NOT NULL,
  first_url   TEXT,
  received_ts INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS session_log_batches (
  sid         TEXT NOT NULL,
  pid         TEXT NOT NULL,
  seq         INTEGER NOT NULL,
  received_ts INTEGER NOT NULL,
  first_ms    INTEGER NOT NULL,
  last_ms     INTEGER NOT NULL,
  n           INTEGER NOT NULL,
  events      TEXT NOT NULL,
  PRIMARY KEY (sid, pid, seq)
);

-- One row (`id = 1`): `until_ms` NULL = off; at or past 2100-01-01 = no end date.
CREATE TABLE IF NOT EXISTS session_log_switch (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  until_ms    INTEGER,
  who         TEXT NOT NULL,
  ts          INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_session_log_email ON session_log (email, last_ms);
CREATE INDEX IF NOT EXISTS idx_session_log_received ON session_log (received_ts);
CREATE INDEX IF NOT EXISTS idx_session_log_batches_received ON session_log_batches (received_ts);
