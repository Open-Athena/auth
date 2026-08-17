export function memoryGrantStore() {
    const rows = new Map();
    const hashes = new Map();
    return {
        rows,
        hashes,
        async byId(id) {
            return rows.get(id) ?? null;
        },
        async byTokenHash(tokenHash) {
            const id = hashes.get(tokenHash);
            return id ? (rows.get(id) ?? null) : null;
        },
        async insert(grant, tokenHash) {
            rows.set(grant.id, { ...grant });
            hashes.set(tokenHash, grant.id);
        },
        async redeem(id, nowS) {
            // Mirrors the D1 adapter's single-statement CAS, guards and all.
            const g = rows.get(id);
            if (!g)
                return null;
            if (g.revokedAt !== null)
                return null;
            if (g.expiresAt !== null && g.expiresAt <= nowS)
                return null;
            if (g.maxRedeems !== null && g.redeems >= g.maxRedeems)
                return null;
            const next = { ...g, redeems: g.redeems + 1, firstUsedAt: g.firstUsedAt ?? nowS, lastUsedAt: nowS };
            rows.set(id, next);
            return next;
        },
        async touch(id, nowS, minIntervalS) {
            const g = rows.get(id);
            if (!g)
                return;
            if (g.lastUsedAt !== null && g.lastUsedAt >= nowS - minIntervalS)
                return;
            rows.set(id, { ...g, lastUsedAt: nowS });
        },
        async revoke(id, nowS) {
            const g = rows.get(id);
            if (!g || g.revokedAt !== null)
                return false;
            rows.set(id, { ...g, revokedAt: nowS });
            return true;
        },
        async list(opts) {
            return [...rows.values()]
                .filter(g => (opts?.includeRevoked || g.revokedAt === null) && (opts?.createdBy === undefined || g.createdBy === opts.createdBy))
                .sort((a, b) => b.createdAt - a.createdAt);
        },
    };
}
export function memoryRequestStore() {
    const rows = new Map();
    const ips = new Map();
    return {
        rows,
        async byId(id) {
            return rows.get(id) ?? null;
        },
        async pendingByEmail(email) {
            return [...rows.values()].find(r => r.email === email && r.status === 'pending') ?? null;
        },
        async insert(request, ipHash) {
            rows.set(request.id, { ...request });
            ips.set(request.id, ipHash);
        },
        async decide(id, { status, decidedBy, grantId, nowS }) {
            const r = rows.get(id);
            if (!r || r.status !== 'pending')
                return null;
            const next = { ...r, status: status, decidedAt: nowS, decidedBy, grantId };
            rows.set(id, next);
            return next;
        },
        async list(opts) {
            return [...rows.values()]
                .filter(r => !opts?.status || r.status === opts.status)
                .sort((a, b) => b.createdAt - a.createdAt)
                .slice(0, opts?.limit ?? 200);
        },
        async countSince(sinceS, by) {
            return [...rows.values()].filter(r => r.createdAt >= sinceS &&
                (by.email !== undefined ? r.email === by.email : by.ipHash != null && ips.get(r.id) === by.ipHash)).length;
        },
    };
}
export function memoryAudit() {
    const events = [];
    return { events, log: async (e) => void events.push(e) };
}
