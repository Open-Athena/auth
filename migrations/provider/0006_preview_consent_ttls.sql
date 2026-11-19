-- How long a preview client's consent click lasts (`ProviderClient.previewConsentTtlS`), in seconds: 0 asks at every
-- sign-in. Admin-set, only for a client in `provider_preview_clients`; without a row, the default (7 days).

CREATE TABLE IF NOT EXISTS provider_preview_consent_ttls (
  client_id TEXT PRIMARY KEY,
  ttl_s     INTEGER NOT NULL
);
