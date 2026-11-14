-- Optional receiver foundation only; no gate/session or provider tables are changed.
CREATE TABLE backchannel_receipts (
  issuer TEXT NOT NULL,
  client_id TEXT NOT NULL,
  jti TEXT NOT NULL,
  digest TEXT NOT NULL,
  sid TEXT NOT NULL,
  sub TEXT,
  accepted_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  retain_until INTEGER NOT NULL CHECK (retain_until >= expires_at),
  PRIMARY KEY (issuer, client_id, jti)
);
CREATE INDEX backchannel_receipts_expiry ON backchannel_receipts (expires_at);

CREATE TABLE backchannel_revoked_sids (
  issuer TEXT NOT NULL,
  client_id TEXT NOT NULL,
  sid TEXT NOT NULL,
  sub TEXT,
  revoked_at INTEGER NOT NULL,
  retain_until INTEGER NOT NULL,
  PRIMARY KEY (issuer, client_id, sid)
);
CREATE INDEX backchannel_sids_expiry ON backchannel_revoked_sids (retain_until);
