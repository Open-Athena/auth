-- A per-email allowlist the SSO policy can consult, so "who is allowed" is a
-- table an admin edits (or a directory sync fills) rather than a hardcoded list
-- redeployed on every board change. `allowlistPolicy(store)` reads it; the rows
-- get there by hand (the /admin panel) or out of band (a `board@` sync that
-- owns a `source` and atomically replaces its own rows).
CREATE TABLE allowed_emails (
  email      TEXT PRIMARY KEY,       -- lowercased on write; the policy lowercases its lookup
  scopes     TEXT NOT NULL,          -- space-separated, same codec as grants.scopes
  source     TEXT NOT NULL DEFAULT 'manual',  -- provenance: 'manual' | 'sync:<group>'; a sync replaces only its own source
  note       TEXT,
  added_by   TEXT,                   -- the admin (or sync job) that wrote the row
  updated_at INTEGER NOT NULL
);

-- `replaceSource` deletes every row of one source before re-inserting the
-- current membership, so a sync run stays O(group) rather than a full scan.
CREATE INDEX allowed_emails_source ON allowed_emails (source);
