-- Apps registered at runtime (`d1ClientRegistry`), and every change to them.
-- Secrets are stored only as `hashClientSecret(secret)`. Rows are disabled, not
-- deleted, so the log stays whole and an id can't be silently reused.

CREATE TABLE IF NOT EXISTS provider_clients (
  id                        TEXT PRIMARY KEY,
  name                      TEXT NOT NULL,
  secret_hash               TEXT NOT NULL,
  redirect_uris             TEXT NOT NULL,
  post_logout_redirect_uris TEXT NOT NULL DEFAULT '[]',
  disabled_at               INTEGER,
  created_at                INTEGER NOT NULL,
  created_by                TEXT NOT NULL,
  updated_at                INTEGER NOT NULL,
  updated_by                TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS provider_client_events (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id TEXT NOT NULL,
  action    TEXT NOT NULL,
  actor     TEXT NOT NULL,
  at        INTEGER NOT NULL,
  detail    TEXT
);

CREATE INDEX IF NOT EXISTS provider_client_events_at ON provider_client_events (at);
