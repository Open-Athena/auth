/**
 * Google Workspace groups → the allowlist table.
 *
 * Google's OIDC id_token never carries group membership, and nothing pushes a
 * group change to a custom app (Google's Shared Signals role is *receiver*,
 * session-revocation only). So "gate this app to board@" is a periodic pull:
 * a service account lists the group, `replaceSource` swaps the rows, and
 * `allowlistPolicy` — re-evaluated on every request — denies a removed member
 * on their next request. Revocation lag is the sync interval, which at 5–15
 * minutes beats the ~1 h token lifetime most orgs accept.
 *
 * The runtime half lives here because it is small and easy to get subtly
 * wrong once per app: mint a service-account token (WebCrypto RS256 JWT-bearer,
 * no library), page through one of two group APIs, filter to active users.
 * The provisioning half (create the SA, grant it read access) stays `gcloud`
 * / IaC — see specs/done/google-directory-sync.md for the recipe and the
 * three auth models. The package holds no credential: the key is passed in.
 *
 * Runs on bare Workers: `fetch` + `crypto.subtle`, no `nodejs_compat`.
 */
import { b64uEncode } from '../core/base64.js';
const enc = new TextEncoder();
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const DIRECTORY_API = 'https://admin.googleapis.com/admin/directory/v1';
export const CLOUD_IDENTITY_API = 'https://cloudidentity.googleapis.com/v1';
/** Read-only scope for the Admin SDK Directory `members.list` path. */
export const DIRECTORY_SCOPE = 'https://www.googleapis.com/auth/admin.directory.group.member.readonly';
/** Read-only scope for the Cloud Identity `memberships.list` path. */
export const CLOUD_IDENTITY_SCOPE = 'https://www.googleapis.com/auth/cloud-identity.groups.readonly';
function parseKey(key) {
    let parsed = key;
    if (typeof key === 'string') {
        try {
            parsed = JSON.parse(key);
        }
        catch {
            throw new Error('service account key: not JSON');
        }
    }
    const k = parsed;
    if (!k || typeof k.client_email !== 'string' || typeof k.private_key !== 'string') {
        throw new Error('service account key: missing client_email or private_key');
    }
    return k;
}
/** PKCS#8 PEM → CryptoKey. The key file's `private_key` is always PKCS#8. */
async function importPrivateKey(pem) {
    const body = pem.replace(/-----(BEGIN|END) PRIVATE KEY-----|\s/g, '');
    const bin = atob(body);
    const der = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++)
        der[i] = bin.charCodeAt(i);
    return crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
}
/**
 * Mint an access token for a service account: sign a JWT-bearer assertion
 * with the key and trade it at the token endpoint. Throws on any failure —
 * every one is a provisioning error (bad key, wrong scope, no role), not a
 * state to handle at runtime.
 */
export async function googleAccessToken({ key, scopes, subject, fetch = globalThis.fetch, nowMs = Date.now(), }) {
    const sa = parseKey(key);
    const tokenUrl = sa.token_uri ?? GOOGLE_TOKEN_URL;
    const iat = Math.floor(nowMs / 1000);
    const claims = {
        iss: sa.client_email,
        scope: scopes.join(' '),
        aud: tokenUrl,
        iat,
        exp: iat + 3600,
        ...(subject ? { sub: subject } : {}),
    };
    const header = b64uEncode(enc.encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
    const payload = b64uEncode(enc.encode(JSON.stringify(claims)));
    const signingKey = await importPrivateKey(sa.private_key);
    const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', signingKey, enc.encode(`${header}.${payload}`));
    const assertion = `${header}.${payload}.${b64uEncode(sig)}`;
    const res = await fetch(tokenUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(),
    });
    if (!res.ok)
        throw new Error(`google token endpoint: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    const body = (await res.json());
    if (typeof body.access_token !== 'string')
        throw new Error('google token endpoint: no access_token in response');
    const expiresIn = typeof body.expires_in === 'number' ? body.expires_in : 3600;
    return { accessToken: body.access_token, expiresAt: iat + expiresIn, clientEmail: sa.client_email };
}
async function getJson(fetch, url, token) {
    const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
    // Google's error body names the missing privilege — the one thing an
    // operator needs when a freshly provisioned SA is refused.
    if (!res.ok)
        throw new Error(`${new URL(url).pathname}: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
    return res.json();
}
async function directoryMembers(fetch, token, group) {
    const out = [];
    let pageToken;
    do {
        const url = new URL(`${DIRECTORY_API}/groups/${encodeURIComponent(group)}/members`);
        url.searchParams.set('includeDerivedMembership', 'true');
        url.searchParams.set('maxResults', '200');
        if (pageToken)
            url.searchParams.set('pageToken', pageToken);
        const page = await getJson(fetch, url.href, token);
        // Nested groups are already flattened into their USER members by
        // `includeDerivedMembership`, so the GROUP rows themselves carry nothing.
        // A suspended user can't sign in to Google anyway; keep the table honest.
        for (const m of page.members ?? []) {
            if (m.type === 'USER' && m.status !== 'SUSPENDED' && typeof m.email === 'string')
                out.push(m.email);
        }
        pageToken = page.nextPageToken;
    } while (pageToken);
    return out;
}
async function cloudIdentityMembers(fetch, token, group) {
    const lookup = await getJson(fetch, `${CLOUD_IDENTITY_API}/groups:lookup?groupKey.id=${encodeURIComponent(group)}`, token);
    if (typeof lookup.name !== 'string')
        throw new Error(`cloud identity: no group ${group}`);
    const out = [];
    let pageToken;
    do {
        const url = new URL(`${CLOUD_IDENTITY_API}/${lookup.name}/memberships`);
        // BASIC (the default view) omits `type`, so the USER filter below would
        // drop everyone; FULL carries it (max page 500).
        url.searchParams.set('view', 'FULL');
        url.searchParams.set('pageSize', '500');
        if (pageToken)
            url.searchParams.set('pageToken', pageToken);
        const page = await getJson(fetch, url.href, token);
        for (const m of page.memberships ?? []) {
            if (m.type === 'USER' && typeof m.preferredMemberKey?.id === 'string')
                out.push(m.preferredMemberKey.id);
        }
        pageToken = page.nextPageToken;
    } while (pageToken);
    return out;
}
/**
 * The group's active user members: lowercased, de-duplicated, sorted. Throws
 * on a non-2xx from Google (a permissions or provisioning problem).
 */
export async function listGroupMembers(group, { token, api = 'cloud-identity', fetch = globalThis.fetch }) {
    const raw = api === 'directory' ? await directoryMembers(fetch, token, group) : await cloudIdentityMembers(fetch, token, group);
    return [...new Set(raw.map(e => e.toLowerCase()))].sort();
}
/** The allowlist `source` a synced group owns: `sync:<group>`. */
export const syncSource = (group) => `sync:${group.toLowerCase()}`;
/**
 * One token, then per group: list → `replaceSource`. Rows carry the group's
 * scopes and `addedBy: <service account email>`. A listing that throws stops
 * before that group's `replaceSource`, so a transient Google error never
 * empties a group — the previous membership stands until the next run.
 *
 * Call this from a Worker `scheduled()` handler (or any cron) with the same
 * `AllowlistStore` the app's `allowlistPolicy` reads.
 */
export async function syncGroupsToAllowlist(store, { groups, api = 'cloud-identity', key, subject, fetch = globalThis.fetch, nowMs = Date.now() }) {
    const scope = api === 'directory' ? DIRECTORY_SCOPE : CLOUD_IDENTITY_SCOPE;
    const { accessToken, clientEmail } = await googleAccessToken({ key, scopes: [scope], subject, fetch, nowMs });
    const updatedAt = Math.floor(nowMs / 1000);
    const results = [];
    for (const { group, scopes } of groups) {
        const emails = await listGroupMembers(group, { token: accessToken, api, fetch });
        const source = syncSource(group);
        const entries = emails.map(email => ({
            email,
            scopes: [...scopes],
            source,
            note: null,
            addedBy: clientEmail,
            updatedAt,
        }));
        await store.replaceSource(source, entries);
        results.push({ group, source, count: entries.length });
    }
    return results;
}
