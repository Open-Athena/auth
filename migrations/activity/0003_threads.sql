-- Slack threads: a burst's sessions (so a tab resumes its own burst), and each post's thread replies. Apply once.
CREATE TABLE activity_burst_sessions (
  burst_id TEXT NOT NULL REFERENCES activity_bursts(id),
  session_id TEXT NOT NULL,
  PRIMARY KEY (burst_id, session_id)
);
CREATE INDEX activity_burst_sessions_session ON activity_burst_sessions(session_id);
-- JSON object: thread reply slot -> message id (e.g. {"details":"…","error":"…"}).
ALTER TABLE activity_posts ADD COLUMN parts TEXT NOT NULL DEFAULT '{}';
