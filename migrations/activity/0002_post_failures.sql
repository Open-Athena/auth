-- Consecutive failed sends per (burst, sink); the feed backs off by this count. Apply once.
ALTER TABLE activity_posts ADD COLUMN failures INTEGER NOT NULL DEFAULT 0;
