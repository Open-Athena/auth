/**
 * What an OIDC provider keeps between `/authorize` and `/token`: the
 * authorization code, by its hash, until it is exchanged once or expires.
 * Everything else is stateless (signed tokens) or the gate's (sessions).
 */
/** A process-local store, for tests and single-instance development. */
export function memoryProviderStore() {
    const codes = new Map();
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
        async cleanup(nowS) {
            let n = 0;
            for (const [k, c] of codes) {
                if (c.expiresAt <= nowS) {
                    codes.delete(k);
                    n++;
                }
            }
            return n;
        },
    };
}
