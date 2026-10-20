export class AuthClientError extends Error {
    status;
    body;
    constructor(status, body) {
        super(`Auth request failed (${status})`);
        this.status = status;
        this.body = body;
        this.name = 'AuthClientError';
    }
}
function segment(id) {
    if (!id || id === '.' || id === '..')
        throw new TypeError('Expected a nonempty, non-dot path segment');
    return encodeURIComponent(id);
}
export function createAuthClient({ basePath = '/api/auth', fetch = globalThis.fetch } = {}) {
    const base = basePath.replace(/\/+$/, '');
    async function request(path, method = 'GET', input) {
        const response = await fetch(`${base}${path}`, {
            method,
            credentials: 'same-origin',
            ...(input === undefined ? {} : {
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(input),
            }),
        });
        let body;
        try {
            const text = await response.text();
            body = text || null;
            if (text) {
                try {
                    body = JSON.parse(text);
                }
                catch (error) {
                    if (response.ok)
                        throw error;
                }
            }
        }
        catch (error) {
            if (response.ok)
                throw error;
            throw new AuthClientError(response.status, undefined);
        }
        if (!response.ok)
            throw new AuthClientError(response.status, body);
        return body;
    }
    const grantPath = (id) => `/grants/${segment(id)}`;
    return {
        whoami: () => request('/whoami'),
        logout: () => request('/logout', 'POST'),
        grants: {
            mint: (input) => request('/grants', 'POST', input),
            list: ({ active } = {}) => request(`/grants${active ? '?active=1' : ''}`),
            update: (id, patch) => request(grantPath(id), 'PATCH', patch),
            revoke: (id) => request(`${grantPath(id)}/revoke`, 'POST'),
            disable: (id) => request(`${grantPath(id)}/disable`, 'POST'),
            enable: (id) => request(`${grantPath(id)}/enable`, 'POST'),
            rotate: (id, input = {}) => request(`${grantPath(id)}/rotate`, 'POST', input),
            activity: (id) => request(`${grantPath(id)}/activity`),
        },
        log: ({ grant, limit } = {}) => {
            const query = new URLSearchParams();
            if (grant !== undefined)
                query.set('grant', grant);
            if (limit !== undefined)
                query.set('limit', String(limit));
            return request(`/log${query.size ? `?${query}` : ''}`);
        },
    };
}
/** Construct locally: the token is never sent to a server by this helper. */
export function shareUrl(token, target) {
    if (target === undefined) {
        if (typeof location === 'undefined')
            throw new Error('shareUrl requires a target outside the browser');
        target = location.href;
    }
    const url = new URL(target);
    url.searchParams.set('key', token);
    return url.href;
}
