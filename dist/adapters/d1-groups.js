export function d1GroupSnapshots(db) {
    return {
        async get(group) {
            const row = await db.prepare('SELECT group_email, members_json, fetched_at FROM group_snapshots WHERE group_email = ?')
                .bind(group.toLowerCase()).first();
            return row ? { group: row.group_email, members: JSON.parse(row.members_json), fetchedAt: row.fetched_at } : null;
        },
        async put(snapshot) {
            await db.prepare(`INSERT INTO group_snapshots (group_email, members_json, fetched_at) VALUES (?, ?, ?)
        ON CONFLICT(group_email) DO UPDATE SET members_json = excluded.members_json, fetched_at = excluded.fetched_at
        WHERE excluded.fetched_at > group_snapshots.fetched_at`)
                .bind(snapshot.group.toLowerCase(), JSON.stringify([...new Set(snapshot.members.map(e => e.toLowerCase()))].sort()), snapshot.fetchedAt).run();
        },
    };
}
