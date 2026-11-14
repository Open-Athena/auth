-- PR-preview clients (`ProviderClient.preview`): their callbacks may include a
-- `https://*.<host>/<path>` pattern for an allowlisted host, and sign-in asks
-- for one click per preview host instead of being silent. A client is a
-- preview client iff it has a row here, written only when it's created.

CREATE TABLE IF NOT EXISTS provider_preview_clients (
  client_id TEXT PRIMARY KEY
);
