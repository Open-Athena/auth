/**
 * The provider's signing keys: RS256, because every relying party here
 * (`verifyRs256Jwt`) and most of the world's OIDC clients expect it.
 *
 * Keys are private RSA JWKs with a `kid`, passed in from a Worker secret. The
 * first one signs; all are published, so rotation is "prepend a new key,
 * deploy, wait out the longest token and JWKS cache lifetime, drop the old".
 */
import { b64uDecodeBytes, b64uDecodeString, b64uEncode } from '../core/base64.js';
const ALG = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' };
const enc = new TextEncoder();
/** A fresh 2048-bit RS256 key, as a private JWK. Store it as a secret; never log it. */
export async function generateSigningKey(kid = `k${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`) {
    const pair = (await crypto.subtle.generateKey({ ...ALG, modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) }, true, ['sign', 'verify']));
    const jwk = (await crypto.subtle.exportKey('jwk', pair.privateKey));
    return { ...jwk, kid, alg: 'RS256' };
}
/** Import the keys once; the result signs and verifies. */
export function keySet(keys) {
    if (!keys.length)
        throw new Error('an OIDC provider needs at least one signing key');
    const kids = new Set();
    for (const k of keys) {
        if (k.kty !== 'RSA' || !k.d)
            throw new Error(`signing key ${k.kid}: not a private RSA JWK`);
        if (kids.has(k.kid))
            throw new Error(`signing key ${k.kid}: duplicate kid`);
        kids.add(k.kid);
    }
    const pub = (k) => ({ kty: 'RSA', n: k.n, e: k.e, kid: k.kid, alg: 'RS256', use: 'sig' });
    const jwks = { keys: keys.map(pub) };
    const strip = ({ kid: _kid, alg: _alg, key_ops: _ops, use: _use, ...k }) => k;
    const signer = crypto.subtle.importKey('jwk', strip(keys[0]), ALG, false, ['sign']);
    const verifiers = new Map(keys.map(k => [k.kid, crypto.subtle.importKey('jwk', pub(k), ALG, false, ['verify'])]));
    return {
        jwks,
        async sign(payload, typ = 'JWT') {
            const header = b64uEncode(enc.encode(JSON.stringify({ alg: 'RS256', kid: keys[0].kid, typ })));
            const body = b64uEncode(enc.encode(JSON.stringify(payload)));
            const sig = await crypto.subtle.sign(ALG.name, await signer, enc.encode(`${header}.${body}`));
            return `${header}.${body}.${b64uEncode(sig)}`;
        },
        async verify(jwt) {
            const parts = jwt.split('.');
            if (parts.length !== 3)
                return null;
            const [h, p, s] = parts;
            let header;
            try {
                header = JSON.parse(b64uDecodeString(h));
            }
            catch {
                return null;
            }
            if (header.alg !== 'RS256' || typeof header.kid !== 'string')
                return null;
            const key = verifiers.get(header.kid);
            if (!key)
                return null;
            let ok;
            try {
                ok = await crypto.subtle.verify(ALG.name, await key, b64uDecodeBytes(s), enc.encode(`${h}.${p}`));
            }
            catch {
                return null;
            }
            if (!ok)
                return null;
            try {
                const claims = JSON.parse(b64uDecodeString(p));
                return claims && typeof claims === 'object' && !Array.isArray(claims) ? claims : null;
            }
            catch {
                return null;
            }
        },
    };
}
