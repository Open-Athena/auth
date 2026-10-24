-- Retained logins hold email sign-ins as well as share-link sessions. `sub` is
-- the principal in the session-cookie format (`e:<email>` or `g:<grant_id>`);
-- `grant_id` is set exactly when it names a grant, so a grant row's revocation
-- and rotation still join in. (A CHECK passes on NULL, hence the explicit
-- `IS NOT NULL`.) SQLite can't relax NOT NULL in place, so the
-- table is rebuilt (nothing references it).
CREATE TABLE retained_sessions_v2 (
  id TEXT PRIMARY KEY NOT NULL,
  browser_set_id TEXT NOT NULL REFERENCES retained_browser_sets(id),
  grant_id TEXT REFERENCES grants(id),
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  sub TEXT NOT NULL,
  CHECK (
    (sub LIKE 'g:_%' AND grant_id IS NOT NULL AND grant_id = substr(sub, 3)) OR
    (sub LIKE 'e:_%' AND grant_id IS NULL)
  )
);
INSERT INTO retained_sessions_v2 (id, browser_set_id, grant_id, issued_at, expires_at, revoked_at, sub)
  SELECT id, browser_set_id, grant_id, issued_at, expires_at, revoked_at, 'g:' || grant_id FROM retained_sessions;
DROP TABLE retained_sessions;
ALTER TABLE retained_sessions_v2 RENAME TO retained_sessions;
CREATE INDEX retained_session_membership ON retained_sessions (browser_set_id, grant_id, expires_at);
CREATE INDEX retained_session_sub ON retained_sessions (browser_set_id, sub);
