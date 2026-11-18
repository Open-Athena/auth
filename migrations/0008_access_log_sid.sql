-- Which browser a row came from (`sid`: a keyed hash of its session cookie, or of its network and user agent when it
-- presented a key instead), so the hourly dedupe of views and repeat denies is per browser, not per grant: everyone
-- who opens one share link shares `session_sub` (`g:<id>`), and a second person's view was being dropped. '' on rows
-- logged before this, and on events with no request. Apply once.
ALTER TABLE access_log ADD COLUMN sid TEXT NOT NULL DEFAULT '';
DROP INDEX access_log_dedupe;
CREATE UNIQUE INDEX access_log_dedupe ON access_log (event, session_sub, sid, path, bucket) WHERE bucket IS NOT NULL;
