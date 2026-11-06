-- Exchanged authorization codes, by hash, kept until their access token expires.
-- Presenting a spent code again marks it revoked, and `/userinfo` then refuses
-- the access token it produced (OAuth 2.0 §4.1.2).

CREATE TABLE IF NOT EXISTS provider_spent_codes (
  code_hash  TEXT PRIMARY KEY,
  revoked    INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS provider_spent_codes_expires ON provider_spent_codes (expires_at);
