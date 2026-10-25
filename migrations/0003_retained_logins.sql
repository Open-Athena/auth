-- Optional substrate only; single-session consumers need not apply this file.
-- No triggers or changes to existing tables. Logical expiry is authoritative.
CREATE TABLE retained_browser_sets (
  id TEXT PRIMARY KEY NOT NULL,
  gate_id TEXT NOT NULL,
  handle_hash TEXT NOT NULL,
  active_session_id TEXT,
  selection_version INTEGER NOT NULL DEFAULT 0 CHECK (selection_version BETWEEN 0 AND 9007199254740991),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  UNIQUE (gate_id, handle_hash)
);
CREATE INDEX retained_browser_gate ON retained_browser_sets (gate_id, expires_at);

CREATE TABLE retained_sessions (
  id TEXT PRIMARY KEY NOT NULL,
  browser_set_id TEXT NOT NULL REFERENCES retained_browser_sets(id),
  grant_id TEXT NOT NULL REFERENCES grants(id),
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX retained_session_membership ON retained_sessions (browser_set_id, grant_id, expires_at);

CREATE TABLE retained_pending (
  id TEXT PRIMARY KEY NOT NULL,
  browser_set_id TEXT NOT NULL REFERENCES retained_browser_sets(id),
  gate_id TEXT NOT NULL,
  grant_id TEXT NOT NULL REFERENCES grants(id),
  token_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_operation_id TEXT,
  ready INTEGER NOT NULL CHECK (ready IN (0, 1))
);
CREATE INDEX retained_pending_browser ON retained_pending (browser_set_id, expires_at);
CREATE INDEX retained_pending_gate ON retained_pending (gate_id, expires_at);

-- attempt_id is server-generated per batch, never caller-controlled. CHECK
-- converts an unexpected zero-row dependent write into transaction rollback.
CREATE TABLE retained_operations (
  id TEXT PRIMARY KEY NOT NULL,
  browser_set_id TEXT NOT NULL REFERENCES retained_browser_sets(id),
  gate_id TEXT NOT NULL,
  input_json TEXT NOT NULL,
  attempt_id TEXT NOT NULL UNIQUE,
  session_id TEXT NOT NULL,
  minted INTEGER NOT NULL CHECK (minted IN (0, 1)),
  committed_version INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  stage INTEGER NOT NULL CHECK (stage BETWEEN 0 AND 5)
);
CREATE INDEX retained_operation_expiry ON retained_operations (expires_at);
