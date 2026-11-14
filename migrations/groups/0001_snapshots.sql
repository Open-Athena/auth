CREATE TABLE group_snapshots (
  group_email TEXT PRIMARY KEY,
  members_json TEXT NOT NULL,
  fetched_at INTEGER NOT NULL
);
