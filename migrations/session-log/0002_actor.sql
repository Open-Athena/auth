-- Apply after 0001_session_log.sql, including on existing session-log deployments.
-- Recipient identity only: never copy a grant's private memo into these columns.
-- Existing rows keep their prior identity; new columns stay NULL until a new batch supplies them.
ALTER TABLE session_log ADD COLUMN grant_id TEXT;
ALTER TABLE session_log ADD COLUMN subject_name TEXT;
