import { hashToken } from '../core/tokens.js';
import { clientIdProblem, redirectUriProblem } from './registry.js';
const ACTIONS = new Set(['read', 'create', 'update', 'disable', 'enable', 'rotate']);
const HASH = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const strings = (v, max) => Array.isArray(v) && v.length <= max && v.every(s => typeof s === 'string' && s.length <= 2048) && new Set(v).size === v.length;
const json = (value, status = 200) => Response.json(value, { status, headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
const error = (message, status) => json({ error: message }, status);
const same = (a, b) => {
    let diff = a.length ^ b.length;
    for (let i = 0; i < a.length; i++)
        diff |= a.charCodeAt(i) ^ (b.charCodeAt(i) || 0);
    return diff === 0;
};
function validPrincipal(value) {
    if (!object(value) || typeof value.actor !== 'string' || !value.actor.trim() || value.actor.length > 200 || /[\x00-\x1f\x7f]/.test(value.actor))
        return false;
    if (!Array.isArray(value.actions) || !value.actions.length || !value.actions.every(a => ACTIONS.has(a)))
        return false;
    if (!object(value.clients) || Object.keys(value.clients).length > 100)
        return false;
    return Object.entries(value.clients).every(([id, p]) => !clientIdProblem(id) && object(p) && strings(p.redirectUris, 20) && p.redirectUris.length > 0 && (p.postLogoutRedirectUris === undefined || strings(p.postLogoutRedirectUris, 20)));
}
/** Hash-only configuration; no cookies, OAuth access tokens or implicit admin access. */
export function managementTokenAuth(grants, { now = () => Math.floor(Date.now() / 1000) } = {}) {
    if (!Array.isArray(grants) || grants.length > 100 || grants.some(g => !validPrincipal(g) || typeof g.tokenHash !== 'string' || !HASH.test(g.tokenHash) || !Number.isSafeInteger(g.expiresAt) || g.expiresAt <= 0) || new Set(grants.map(g => g.tokenHash)).size !== grants.length) {
        throw new TypeError('management: invalid grants');
    }
    // Copy configuration so a caller cannot broaden a capability by mutating its input.
    const configured = structuredClone(grants);
    return async (request) => {
        const authorization = request.headers.get('authorization');
        if (!authorization || !/^Bearer [A-Za-z0-9_-]{43,256}$/.test(authorization))
            return error('machine authorization required', 401);
        const hash = await hashToken(authorization.slice(7));
        const grant = configured.find(g => same(g.tokenHash, hash));
        if (!grant || grant.expiresAt <= now())
            return error('machine authorization required', 401);
        return structuredClone({ actor: grant.actor, actions: grant.actions, clients: grant.clients });
    };
}
const metadata = (c) => ({
    id: c.id, name: c.name, redirectUris: c.redirectUris, postLogoutRedirectUris: c.postLogoutRedirectUris,
    disabledAt: c.disabledAt, createdAt: c.createdAt, createdBy: c.createdBy, updatedAt: c.updatedAt, updatedBy: c.updatedBy,
});
const equalList = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
const matches = (c, v) => c.name === v.name && equalList(c.redirectUris, v.redirectUris) && equalList(c.postLogoutRedirectUris, v.postLogoutRedirectUris);
async function bodyOf(request) {
    if (request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json')
        return error('application/json required', 415);
    const length = request.headers.get('content-length');
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > 65536))
        return error('body too large', 413);
    const reader = request.body?.getReader();
    if (!reader)
        return error('JSON object required', 400);
    const chunks = [];
    let size = 0;
    try {
        while (true) {
            const { value, done } = await reader.read();
            if (done)
                break;
            size += value.byteLength;
            if (size > 65536) {
                void reader.cancel().catch(() => { });
                return error('body too large', 413);
            }
            chunks.push(value);
        }
    }
    catch {
        return error('invalid body', 400);
    }
    finally {
        reader.releaseLock();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }
    try {
        const value = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes));
        return object(value) ? value : error('JSON object required', 400);
    }
    catch {
        return error('JSON object required', 400);
    }
}
/** Scoped operator API. It never generates, accepts or returns plaintext client secrets. */
export function clientManagementRoutes({ registry, authorize, redirectDomains, reservedClientIds = [], basePath = '/api/clients' }) {
    if (typeof authorize !== 'function')
        throw new TypeError('management: authorize is required');
    const base = basePath.replace(/\/$/, '');
    if (!/^\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+$/.test(base))
        throw new TypeError('management: invalid base path');
    const reserved = new Set(reservedClientIds);
    return async (request) => {
        const path = new URL(request.url).pathname;
        if (path !== base && !path.startsWith(`${base}/`))
            return null;
        const principal = await authorize(request);
        if (principal instanceof Response) {
            // Never forward an authorization callback's arbitrary body (which may contain credentials).
            return error('machine authorization required', principal.status === 401 ? 401 : 403);
        }
        if (!validPrincipal(principal))
            return error('machine authorization required', 403);
        const scoped = (id) => own(principal.clients, id) && !reserved.has(id);
        const parts = path === base ? [] : path.slice(base.length + 1).split('/');
        let id = '';
        try {
            id = decodeURIComponent(parts[0] ?? '');
        }
        catch {
            return error('invalid client id', 400);
        }
        if (parts.length > 2 || (parts.length && (clientIdProblem(id) || !scoped(id))))
            return error('not found', 404);
        const action = parts.length === 0 && request.method === 'GET' ? 'read'
            : parts.length === 1 && request.method === 'GET' ? 'read'
                : parts.length === 1 && request.method === 'PUT' ? 'create'
                    : parts.length === 1 && request.method === 'PATCH' ? 'update'
                        : parts.length === 2 && request.method === 'POST' && ['disable', 'enable', 'rotate'].includes(parts[1]) ? parts[1] : null;
        if (!action)
            return error('method or route not supported', 405);
        if (!principal.actions.includes(action))
            return error('operation not allowed', 403);
        if (action === 'read') {
            if (!parts.length)
                return json({ clients: (await registry.list()).filter(c => scoped(c.id)).map(metadata) });
            const client = await registry.get(id);
            return client ? json({ client: metadata(client) }) : error('not found', 404);
        }
        if (request.headers.has('origin'))
            return error('browser mutation refused', 403);
        const body = await bodyOf(request);
        if (body instanceof Response)
            return body;
        const allowed = action === 'create' ? ['name', 'secretHash', 'redirectUris', 'postLogoutRedirectUris']
            : action === 'update' ? ['name', 'redirectUris', 'postLogoutRedirectUris']
                : action === 'rotate' ? ['secretHash', 'expectedSecretHash'] : [];
        if (Object.keys(body).some(k => !allowed.includes(k)))
            return error('unexpected field', 400);
        if (action === 'create' || action === 'update') {
            if (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 100 || /[\x00-\x1f\x7f]/.test(body.name))
                return error('invalid name', 400);
            if (!strings(body.redirectUris, 20) || body.redirectUris.length === 0 || (body.postLogoutRedirectUris !== undefined && !strings(body.postLogoutRedirectUris, 20)))
                return error('invalid callback lists', 400);
            const change = { name: body.name, redirectUris: body.redirectUris, postLogoutRedirectUris: body.postLogoutRedirectUris ?? [] };
            const policy = principal.clients[id];
            if (change.redirectUris.some(u => !policy.redirectUris.includes(u)) || change.postLogoutRedirectUris.some(u => !policy.postLogoutRedirectUris?.includes(u)))
                return error('callback not allowed', 403);
            if ([...change.redirectUris, ...change.postLogoutRedirectUris].some(u => redirectUriProblem(u, redirectDomains)))
                return error('invalid callback URL', 400);
            if (action === 'create') {
                if (typeof body.secretHash !== 'string' || !HASH.test(body.secretHash))
                    return error('invalid secret hash', 400);
                const existing = await registry.get(id);
                if (existing)
                    return matches(existing, change) && same(existing.secretHash, body.secretHash) ? json({ client: metadata(existing), changed: false }) : error('client already exists with different configuration', 409);
                const created = await registry.create({ id, ...change, secretHash: body.secretHash }, principal.actor);
                const client = await registry.get(id);
                if (!client || !matches(client, change) || !same(client.secretHash, body.secretHash))
                    return error('client already exists with different configuration', 409);
                return json({ client: metadata(client), changed: created }, created ? 201 : 200);
            }
            const current = await registry.get(id);
            if (!current)
                return error('not found', 404);
            const changed = !matches(current, change);
            if (changed && !await registry.update(id, change, principal.actor))
                return error('not found', 404);
            return json({ client: metadata((await registry.get(id))), changed });
        }
        const current = await registry.get(id);
        if (!current)
            return error('not found', 404);
        if (action === 'rotate') {
            if (typeof body.secretHash !== 'string' || !HASH.test(body.secretHash) || typeof body.expectedSecretHash !== 'string' || !HASH.test(body.expectedSecretHash) || body.secretHash === body.expectedSecretHash)
                return error('invalid rotation hashes', 400);
            if (!registry.rotateIfCurrent)
                return error('atomic rotation not supported', 501);
            if (same(current.secretHash, body.secretHash))
                return json({ client: metadata(current), changed: false });
            const changed = await registry.rotateIfCurrent(id, body.expectedSecretHash, body.secretHash, principal.actor);
            const client = await registry.get(id);
            if (!client || !same(client.secretHash, body.secretHash))
                return error('secret changed; rotation refused', 409);
            return json({ client: metadata(client), changed });
        }
        const disabled = action === 'disable';
        if (!registry.setDisabledIfChanged)
            return error('atomic state transition not supported', 501);
        const changed = await registry.setDisabledIfChanged(id, disabled, principal.actor);
        const client = await registry.get(id);
        if (!client)
            return error('not found', 404);
        if ((client.disabledAt !== null) !== disabled)
            return error('client state changed; retry explicitly', 409);
        return json({ client: metadata(client), changed });
    };
}
