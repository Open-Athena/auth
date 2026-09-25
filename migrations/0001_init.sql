-- The whole schema, for a fresh install. Pre-1.0, migrations are squashed:
-- to move an existing database across a squash, bring it to the previous head,
-- then mark this file applied with `scripts/d1-rebaseline.mjs`.
--
-- Timestamps are epoch seconds (INTEGER): they compare and bucket cheaply, and
-- the access log joins against them. Tokens, codes and IPs are only ever stored
-- hashed.

-- Grants: named, capped, expiring share links (a grant with `email` set is a
-- magic link). Tokens are shown once at mint; only SHA-256 hashes are stored.
-- Every knob is optional: zero-config is an unlimited-use, never-expiring,
-- unnamed link.
CREATE TABLE grants (
  id                      TEXT PRIMARY KEY,     -- random, not autoincrement: doesn't leak counts
  token_hash              TEXT NOT NULL UNIQUE, -- SHA-256, base64url
  name                    TEXT,                 -- admin-side label (the memo): "Q3 board pack"
  note                    TEXT,                 -- freeform: why this exists
  subject_json            TEXT,                 -- optional pre-loaded identity: {name,email,avatar}
  email                   TEXT,                 -- if set: magic-link semantics (bind on redeem)
  scopes                  TEXT NOT NULL,        -- space-separated
  max_redeems             INTEGER,              -- NULL = unlimited; counts sessions minted, not requests
  redeems                 INTEGER NOT NULL DEFAULT 0,
  expires_at              INTEGER,              -- NULL = never
  -- 1: expiry also ends sessions minted from the link ("access ends Friday");
  -- 0: `expires_at` is only a redemption window, and sessions live out `session_ttl`.
  expiry_ends_sessions    INTEGER NOT NULL DEFAULT 1,
  session_ttl             INTEGER,              -- seconds; NULL = inherit app default
  created_at              INTEGER NOT NULL,
  created_by              TEXT NOT NULL,
  disabled_at             INTEGER,              -- no new redemptions; sessions already minted keep working
  revoked_at              INTEGER,              -- no redemptions, and every session it minted ends on its next request
  sessions_invalid_before INTEGER,              -- rotation epoch: grant sessions issued before it are rejected
  first_used_at           INTEGER,
  last_used_at            INTEGER
);

CREATE INDEX grants_created_at ON grants (created_at DESC);
CREATE INDEX grants_disabled_at ON grants (disabled_at);

-- The access log: auth-lifecycle events and (optionally) views in one store, so
-- "who viewed what" joins to `grants` natively. `ip_hash` is an HMAC under the
-- app's session secret: it correlates sessions without retaining addresses.
CREATE TABLE access_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          INTEGER NOT NULL,
  event       TEXT NOT NULL,   -- redeem | deny | revoke | request | view | signin | signout
  grant_id    TEXT,
  session_sub TEXT,            -- `e:<email>` | `g:<id>`
  path        TEXT,
  status      INTEGER,
  ip_hash     TEXT,
  ua          TEXT,
  country     TEXT,
  referer     TEXT,
  reason      TEXT,            -- deny detail: bad-token | revoked | expired | exhausted | not-allowed
  bucket      INTEGER          -- floor(ts/3600) for deduped rows (views, repeat denies); NULL otherwise
);

CREATE INDEX access_log_ts ON access_log (ts DESC);
CREATE INDEX access_log_grant ON access_log (grant_id, ts DESC);

-- One row per (event, session, path, hour) for bucketed events, so a chatty SPA
-- or a revoked link's browser writes one row an hour instead of thousands.
-- Unbucketed lifecycle events always land.
CREATE UNIQUE INDEX access_log_dedupe ON access_log (event, session_sub, path, bucket) WHERE bucket IS NOT NULL;

-- Daily rollups: raw rows answer "what exactly did Bob do last Tuesday", which
-- decays fast; rollups keep "how much traffic, from whom, over the year" after
-- the raw rows are dropped.
CREATE TABLE access_log_daily (
  day      INTEGER NOT NULL,   -- floor(ts / 86400)
  event    TEXT NOT NULL,
  grant_id TEXT,
  path     TEXT,
  country  TEXT,
  events   INTEGER NOT NULL,   -- rows collapsed into this bucket
  clients  INTEGER NOT NULL,   -- distinct ip_hash values within it
  PRIMARY KEY (day, event, grant_id, path, country)
);

CREATE INDEX access_log_daily_day ON access_log_daily (day DESC);
CREATE INDEX access_log_daily_grant ON access_log_daily (grant_id, day DESC);

-- Request access: the wall's affordance for everyone the policy doesn't admit.
-- Approval mints a grant (`grant_id`) and delivers it to `email`, so no
-- pre-verification round-trip is needed: typing someone else's address just
-- mails the real owner.
CREATE TABLE access_requests (
  id           TEXT PRIMARY KEY,
  email        TEXT NOT NULL,
  name         TEXT,
  note         TEXT,
  subject_json TEXT,           -- who they are, as `grants.subject_json`, for the grant approval mints
  created_at   INTEGER NOT NULL,
  status       TEXT NOT NULL,  -- pending | approved | denied | auto
  decided_at   INTEGER,
  decided_by   TEXT,
  grant_id     TEXT,
  ip_hash      TEXT            -- HMAC, for rate-limiting; never a raw address
);

CREATE INDEX access_requests_created_at ON access_requests (created_at DESC);
CREATE INDEX access_requests_status ON access_requests (status, created_at DESC);
CREATE INDEX access_requests_email ON access_requests (email, created_at DESC);

-- At most one open request per address: a re-visit updates the wall's "pending"
-- state rather than queueing a second row for an admin to wade through.
CREATE UNIQUE INDEX access_requests_one_pending ON access_requests (email) WHERE status = 'pending';

-- Self-set identity for a signed-in principal: the name and face an email
-- session chooses for itself (a grant's subject is admin-owned). Keyed by email,
-- the one identity a Google id_token and an emailed code share.
--
-- `avatar` is a `data:` URI (≤ 64 KB, inlined) or an `asset://<id>` ref served
-- from the app's own origin — never a live remote URL, which would tell a third
-- party "this person opened this" on every render.
CREATE TABLE profiles (
  email      TEXT PRIMARY KEY,
  name       TEXT,
  avatar     TEXT,
  avatar_src TEXT,             -- provenance for re-resolve/debug: 'upload' | 'url' | 'github' | 'gravatar'
  updated_at INTEGER NOT NULL
);

-- Pending email-code sign-ins. One row backs both a magic link and a 6-digit
-- code (the code rescues the cross-device case and survives link-prefetching
-- scanners). Both are stored hashed; the row is single-use (`consumed_at`),
-- short-lived (`expires_at`), and `attempts` is capped against brute force.
CREATE TABLE pending_auth (
  id          TEXT PRIMARY KEY,
  email       TEXT NOT NULL,
  token_hash  TEXT NOT NULL,
  code_hash   TEXT NOT NULL,
  ip_hash     TEXT,            -- HMAC of the requesting IP, for per-source rate limits
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  consumed_at INTEGER,
  attempts    INTEGER NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX pending_auth_token ON pending_auth (token_hash);
CREATE INDEX pending_auth_email ON pending_auth (email, created_at);
CREATE INDEX pending_auth_ip ON pending_auth (ip_hash, created_at);

-- A per-email allowlist the sign-in policy can consult (`allowlistPolicy`), so
-- "who is allowed" is a table an admin edits or a directory sync fills.
CREATE TABLE allowed_emails (
  email      TEXT PRIMARY KEY,               -- lowercased on write; the policy lowercases its lookup
  scopes     TEXT NOT NULL,                  -- space-separated, same codec as grants.scopes
  source     TEXT NOT NULL DEFAULT 'manual', -- 'manual' | 'sync:<group>'; a sync replaces only its own source
  note       TEXT,
  added_by   TEXT,                           -- the admin (or sync job) that wrote the row
  updated_at INTEGER NOT NULL
);

CREATE INDEX allowed_emails_source ON allowed_emails (source);
