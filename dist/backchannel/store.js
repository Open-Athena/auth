export function checkBinding(binding, nowS) {
    for (const value of [binding.issuer, binding.clientId, binding.sid]) {
        if (typeof value !== 'string' || !value.length || value.length > 4096)
            throw new TypeError('invalid logout evidence');
    }
    if (!Number.isSafeInteger(nowS) || nowS < 0)
        throw new RangeError('invalid lookup time');
}
export function checkAcceptance(evidence, nowS, retainUntil) {
    checkBinding(evidence, nowS);
    for (const value of [evidence.jti, evidence.digest]) {
        if (typeof value !== 'string' || !value.length || value.length > 4096)
            throw new TypeError('invalid logout evidence');
    }
    if (evidence.sub !== null && (typeof evidence.sub !== 'string' || !evidence.sub.length || evidence.sub.length > 4096))
        throw new TypeError('invalid logout subject');
    if (![nowS, retainUntil, evidence.issuedAt, evidence.expiresAt].every(Number.isSafeInteger)
        || nowS < 0 || evidence.issuedAt < 0 || evidence.expiresAt <= evidence.issuedAt
        || evidence.expiresAt <= nowS || retainUntil < evidence.expiresAt)
        throw new RangeError('invalid logout retention or time');
}
export function checkCleanup(nowS, limit) {
    if (!Number.isSafeInteger(nowS) || nowS < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
        throw new RangeError('invalid cleanup bounds');
    }
}
const key = (...parts) => JSON.stringify(parts);
export function memoryBackchannelStore() {
    const receipts = new Map();
    const revoked = new Map();
    return {
        async accept(e, nowS, retainUntil) {
            checkAcceptance(e, nowS, retainUntil);
            const receiptKey = key(e.issuer, e.clientId, e.jti);
            const old = receipts.get(receiptKey);
            if (old)
                return old.digest === e.digest ? 'duplicate' : 'conflict';
            const sidKey = key(e.issuer, e.clientId, e.sid);
            const tombstone = revoked.get(sidKey);
            if (tombstone?.sub && e.sub && tombstone.sub !== e.sub)
                return 'conflict';
            receipts.set(receiptKey, { digest: e.digest, expiresAt: e.expiresAt });
            revoked.set(sidKey, { sub: tombstone?.sub ?? e.sub, retainUntil: Math.max(tombstone?.retainUntil ?? 0, retainUntil) });
            return 'accepted';
        },
        async isRevoked(b, nowS) {
            checkBinding(b, nowS);
            return (revoked.get(key(b.issuer, b.clientId, b.sid))?.retainUntil ?? 0) > nowS;
        },
        async cleanup(nowS, limit = 500) {
            checkCleanup(nowS, limit);
            let gone = 0;
            let receiptGone = 0;
            for (const [k, v] of receipts) {
                if (receiptGone === limit)
                    break;
                if (v.expiresAt <= nowS) {
                    receipts.delete(k);
                    receiptGone++;
                }
            }
            for (const [k, v] of revoked) {
                if (gone === limit)
                    break;
                if (v.retainUntil <= nowS) {
                    revoked.delete(k);
                    gone++;
                }
            }
            return receiptGone + gone;
        },
    };
}
