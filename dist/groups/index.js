export const DEFAULT_GROUP_MAX_AGE_S = 15 * 60;
/** Check on every authorization request, not only at OAuth sign-in. */
export function groupPolicy(store, opts) {
    const maxAgeS = opts.maxAgeS ?? DEFAULT_GROUP_MAX_AGE_S;
    if (!Number.isFinite(maxAgeS) || maxAgeS <= 0)
        throw new Error('groups: maxAgeS must be positive and finite');
    const groups = Object.entries(opts.groups).map(([group, scopes]) => [group.toLowerCase(), scopes]);
    return async (email) => {
        const nowS = Math.floor((opts.nowMs ?? Date.now)() / 1000);
        const snapshots = await Promise.all(groups.map(async ([group, scopes]) => ({ group, scopes, snapshot: await store.get(group) })));
        const allowed = new Set();
        for (const { group, scopes, snapshot } of snapshots) {
            if (!snapshot || snapshot.group.toLowerCase() !== group || !Number.isFinite(snapshot.fetchedAt))
                continue;
            const age = nowS - snapshot.fetchedAt;
            if (age < 0 || age >= maxAgeS)
                continue;
            if (snapshot.members.some(member => member.toLowerCase() === email.toLowerCase())) {
                for (const scope of scopes)
                    allowed.add(scope);
            }
        }
        return allowed.size ? [...allowed].sort() : null;
    };
}
