/**
 * Which callback URLs a client may be sent to. Exact matches, plus one narrow
 * pattern for PR-preview clients (`ProviderClient.preview`): a registered
 * `https://*.<suffix>/<path>` admits `https://<label>.<suffix>/<path>`, where
 * `<label>` is exactly one DNS label (a Pages branch alias such as `pr-12`),
 * and nothing else about the URL varies: no port, query or fragment, and the
 * URL must already be in normal form, since the token endpoint compares it
 * exactly. Which suffixes may carry a pattern at all is the deployment's
 * allowlist (`redirectUriProblem`'s `previewSuffixes`), not the client's.
 */
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const WILD = 'https://*.';
/** A registered `https://*.<suffix>/<path>`: its suffix and path, or null if it isn't a well-formed pattern. */
export function previewPattern(raw) {
    if (!raw.startsWith(WILD))
        return null;
    const concrete = `https://x.${raw.slice(WILD.length)}`;
    let u;
    try {
        u = new URL(concrete);
    }
    catch {
        return null;
    }
    if (u.toString() !== concrete || u.port || u.username || u.password || u.search || u.hash || raw.includes('#') || raw.includes('?'))
        return null;
    const suffix = u.hostname.slice(2);
    // At least `<project>.<tld>` under the wildcard: never `*.dev` or `*.com`.
    if (suffix.split('.').length < 2 || !suffix.split('.').every(l => LABEL.test(l)))
        return null;
    return { suffix, path: u.pathname };
}
/**
 * Whether `uri` is one of `registered`: exactly, or, for a preview client
 * only, under one of its patterns. A pattern string is never an exact match
 * for itself.
 */
export function redirectAllowed(registered, uri, preview) {
    if (!uri.startsWith(WILD) && registered.includes(uri))
        return true;
    if (!preview)
        return false;
    let u;
    try {
        u = new URL(uri);
    }
    catch {
        return false;
    }
    if (u.toString() !== uri || u.protocol !== 'https:' || u.port || u.username || u.password || u.search || u.hash)
        return false;
    const dot = u.hostname.indexOf('.');
    const label = u.hostname.slice(0, dot);
    const rest = u.hostname.slice(dot + 1);
    if (dot < 1 || !LABEL.test(label))
        return false;
    return registered.some(r => {
        const p = previewPattern(r);
        return p !== null && p.suffix === rest && p.path === u.pathname;
    });
}
