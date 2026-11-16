-- A person's custom Slack emoji (`:name:`): set by broker admins and the backfill, copied by an app from the broker's
-- `oa_slack_emoji` claim at each sign-in. Never self-set. Apply once.
ALTER TABLE profiles ADD COLUMN slack_emoji TEXT;
