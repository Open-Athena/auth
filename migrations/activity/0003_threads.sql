-- Slack threads: a burst's sessions (so a tab resumes its own burst), each post's thread replies, and service-link state. Apply once.
CREATE TABLE activity_burst_sessions (
  burst_id TEXT NOT NULL REFERENCES activity_bursts(id),
  session_id TEXT NOT NULL,
  PRIMARY KEY (burst_id, session_id)
);
CREATE INDEX activity_burst_sessions_session ON activity_burst_sessions(session_id);
-- JSON object: thread reply slot -> message id (e.g. {"details":"…","error":"…"}).
ALTER TABLE activity_posts ADD COLUMN parts TEXT NOT NULL DEFAULT '{}';
-- Service links (via 'service'): an opaque client fingerprint per event (an app-chosen hash, never a raw address),
-- so a burst from a client the service hasn't used before is notable; and whether its last notice was red.
ALTER TABLE activity_events ADD COLUMN client TEXT;
CREATE INDEX activity_events_client ON activity_events(client) WHERE client IS NOT NULL;
CREATE TABLE activity_service_state (
  actor_id TEXT NOT NULL,
  origin TEXT NOT NULL,
  sink TEXT NOT NULL,
  red INTEGER NOT NULL CHECK (red IN (0, 1)),
  updated_ts INTEGER NOT NULL,
  PRIMARY KEY (actor_id, origin, sink)
);
