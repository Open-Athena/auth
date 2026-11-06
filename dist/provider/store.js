/**
 * What an OIDC provider keeps between `/authorize` and `/token`: the
 * authorization code, by its hash, until it is exchanged once or expires.
 * It also remembers a spent code until its tokens expire, so that presenting the
 * code again can revoke them. Everything else is stateless (signed tokens) or the
 * gate's (sessions).
 */
/** A process-local store, for tests and single-instance development. */
export function memoryProviderStore() {
    const codes = new Map();
    const spent = new Map();
    return {
        codes,
        async putCode(code) {
            codes.set(code.codeHash, { ...code });
        },
        async takeCode(codeHash, nowS) {
            const c = codes.get(codeHash);
            if (!c)
                return null;
            codes.delete(codeHash);
            return c.expiresAt > nowS ? c : null;
        },
        async noteSpent(codeHash, expiresAt) {
            spent.set(codeHash, { revoked: false, expiresAt });
        },
        async revokeSpent(codeHash) {
            const s = spent.get(codeHash);
            if (s)
                s.revoked = true;
        },
        async isSpentRevoked(codeHash) {
            return spent.get(codeHash)?.revoked ?? false;
        },
        async cleanup(nowS) {
            let n = 0;
            for (const m of [codes, spent]) {
                for (const [k, c] of m) {
                    if (c.expiresAt <= nowS) {
                        m.delete(k);
                        n++;
                    }
                }
            }
            return n;
        },
    };
}
