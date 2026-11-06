-- The optional OIDC provider (`@open-athena/auth/provider`), a migration
-- track of its own: apply it only on a deployment that issues identity (the
-- broker), never on an ordinary app. Authorization codes only, by hash, each
-- deleted when exchanged or swept when expired.

CREATE TABLE IF NOT EXISTS provider_codes (
  code_hash    TEXT PRIMARY KEY,
  client_id    TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  challenge    TEXT NOT NULL,
  nonce        TEXT,
  email        TEXT NOT NULL,
  scope        TEXT NOT NULL,
  auth_time    INTEGER,
  expires_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS provider_codes_expires ON provider_codes (expires_at);
