/**
 * Kept share-link keys, sealed at rest. A link's key is a bearer token handed to outside people, so keeping a copy
 * adds little next to the minter's sent mail and the recipient's inbox; what it must not add is "a database dump
 * opens every live link". So the copy is AES-GCM-sealed under a key derived (HKDF) from a Worker secret, and bound to
 * its grant id, so a sealed key moved onto another row won't open. The hash stays the lookup path.
 */
import { b64uDecodeBytes, b64uEncode } from './base64.js';
const enc = new TextEncoder();
const INFO = enc.encode('oa-auth kept grant token v1');
const PREFIX = 'v1.';
const keys = new Map();
function keyFor(secret) {
    let key = keys.get(secret);
    if (!key) {
        key = crypto.subtle.importKey('raw', enc.encode(secret), 'HKDF', false, ['deriveKey']).then(ikm => crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(), info: INFO }, ikm, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']));
        keys.set(secret, key);
    }
    return key;
}
export async function sealToken(token, grantId, secret) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(grantId) }, await keyFor(secret), enc.encode(token)));
    const out = new Uint8Array(iv.length + sealed.length);
    out.set(iv);
    out.set(sealed, iv.length);
    return `${PREFIX}${b64uEncode(out)}`;
}
/** The kept key, or null when it can't be opened (another secret, another grant's copy, a damaged value). */
export async function openToken(sealed, grantId, secret) {
    if (!sealed.startsWith(PREFIX))
        return null;
    try {
        const bytes = b64uDecodeBytes(sealed.slice(PREFIX.length));
        const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12), additionalData: enc.encode(grantId) }, await keyFor(secret), bytes.slice(12));
        return new TextDecoder().decode(plain);
    }
    catch {
        return null;
    }
}
