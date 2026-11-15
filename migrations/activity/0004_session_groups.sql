-- `activityFeed({ by: 'session' })`: a burst started by a tab's session belongs to that session (one thread per tab). Apply once.
ALTER TABLE activity_bursts ADD COLUMN session_key TEXT;
CREATE INDEX activity_bursts_session ON activity_bursts(actor_id, origin, session_key, last_ts DESC, id DESC) WHERE session_key IS NOT NULL;
