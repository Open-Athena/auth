-- Per-link flags, both editable by staff after minting. Apply once.
-- service: the link is held by a job, not a person (never bound to an email; activity posts only notable events).
-- anon: the holder never sees the link's subject or email; staff still do.
ALTER TABLE grants ADD COLUMN service INTEGER NOT NULL DEFAULT 0;
ALTER TABLE grants ADD COLUMN anon INTEGER NOT NULL DEFAULT 0;
