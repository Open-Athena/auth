-- A preview client's PR source (`ProviderClient.previewSource`, specs/done/preview-pr-context.md): the GitHub
-- repo and host-label template (`pr-{n}`) the consent page looks its PR up by. Admin-set, only for a client
-- in `provider_preview_clients`. `source` is the JSON `{ provider, repo, label }`.

CREATE TABLE IF NOT EXISTS provider_preview_sources (
  client_id TEXT PRIMARY KEY,
  source    TEXT NOT NULL
);
