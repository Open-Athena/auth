import { generateId } from '../core/tokens.js';
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
            if (g.disabledAt !== null)
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
        async setDisabled(id, nowS) {
            const g = rows.get(id);
            // Revocation is final: a revoked link can never be re-enabled.
            if (!g || g.revokedAt !== null)
                return false;
            rows.set(id, { ...g, disabledAt: nowS });
            return true;
        },
        async rotate(id, newTokenHash, sessionsInvalidBefore) {
            const g = rows.get(id);
            if (!g || g.revokedAt !== null)
                return null;
            // Drop the old token->id mapping so the old raw link stops resolving,
            // then point the new hash at the same row.
            for (const [h, gid] of hashes)
                if (gid === id)
                    hashes.delete(h);
            hashes.set(newTokenHash, id);
            // COALESCE semantics: a plain re-key (null) keeps any prior epoch.
            const next = { ...g, sessionsInvalidBefore: sessionsInvalidBefore ?? g.sessionsInvalidBefore };
            rows.set(id, next);
            return next;
        },
        async update(id, patch) {
            const g = rows.get(id);
            if (!g)
                return null;
            const next = { ...g };
            if ('name' in patch)
                next.name = patch.name ?? null;
            if ('note' in patch)
                next.note = patch.note ?? null;
            if ('expiresAt' in patch)
                next.expiresAt = patch.expiresAt ?? null;
            if ('maxRedeems' in patch)
                next.maxRedeems = patch.maxRedeems ?? null;
            if ('sessionTtlS' in patch)
                next.sessionTtlS = patch.sessionTtlS ?? null;
            if ('expiryEndsSessions' in patch)
                next.expiryEndsSessions = patch.expiryEndsSessions ?? true;
            rows.set(id, next);
            return next;
        },
        async list(opts) {
            return [...rows.values()]
                .filter(g => (opts?.includeRevoked || g.revokedAt === null) &&
                (opts?.includeDisabled !== false || g.disabledAt === null) &&
                (opts?.createdBy === undefined || g.createdBy === opts.createdBy))
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
        async reverse(id, { from, status, decidedBy, grantId, nowS }) {
            const r = rows.get(id);
            if (!r || r.status !== from)
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
export function memoryProfileStore() {
    const rows = new Map();
    return {
        rows,
        async get(email) {
            return rows.get(email) ?? null;
        },
        async put(profile) {
            rows.set(profile.email, { ...profile });
        },
        async del(email) {
            rows.delete(email);
        },
    };
}
export function memoryPendingAuthStore() {
    const rows = new Map();
    return {
        rows,
        async insert(row) {
            rows.set(row.id, { ...row });
        },
        async byId(id) {
            const row = rows.get(id);
            return row ? { ...row } : null;
        },
        async byTokenHash(tokenHash) {
            for (const row of rows.values())
                if (row.tokenHash === tokenHash)
                    return { ...row };
            return null;
        },
        async consume(id, nowS) {
            const row = rows.get(id);
            if (!row || row.consumedAt !== null)
                return null;
            row.consumedAt = nowS;
            return { ...row };
        },
        async bumpAttempts(id) {
            const row = rows.get(id);
            if (!row)
                return 0;
            row.attempts += 1;
            return row.attempts;
        },
        async countSince(email, sinceS) {
            let n = 0;
            for (const row of rows.values())
                if (row.email === email && row.createdAt >= sinceS)
                    n++;
            return n;
        },
        async countSinceByIp(ipHash, sinceS) {
            let n = 0;
            for (const row of rows.values())
                if (row.ipHash === ipHash && row.createdAt >= sinceS)
                    n++;
            return n;
        },
    };
}
export function memoryAssetStore() {
    const rows = new Map();
    return {
        rows,
        async put(bytes, type) {
            const id = generateId();
            rows.set(id, { bytes, type });
            return id;
        },
        async get(id) {
            return rows.get(id) ?? null;
        },
        async del(id) {
            rows.delete(id);
        },
    };
}
export function memoryAudit() {
    const events = [];
    return { events, log: async (e) => void events.push(e) };
}
