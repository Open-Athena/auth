import { hasScope } from '../core/types.js';
export * from '../core/session-log-shape.js';
export * from './store.js';
export { sessionLogRoutes } from './routes.js';
/**
 * `identify` and `requireAdmin` from an `@open-athena/auth` gate. A link
 * session is logged under its bound address when it has one (`via: 'grant'`),
 * else with no address; an SSO session under its email (`via: 'sso'`).
 */
export function fromGate(gate, opts = {}) {
    const { adminScope = 'admin', anonymous = false } = opts;
    // `logView: false`: these are plumbing requests, not page views.
    const auth = (req) => gate.authenticateResult(req, Date.now(), { logView: false });
    return {
        async identify(req) {
            const a = (await auth(req)).auth;
            if (!a)
                return anonymous ? { email: null, via: 'public' } : null;
            return a.kind === 'sso' ? { email: a.email, via: 'sso' } : { email: a.grant.email, via: 'grant' };
        },
        async requireAdmin(req) {
            const result = await auth(req);
            const a = result.auth;
            if (!a)
                return gate.unauthenticated(req, result);
            if (!hasScope(a, adminScope)) {
                return new Response(JSON.stringify({ error: 'forbidden' }), { status: 403, headers: { 'content-type': 'application/json' } });
            }
            return { who: a.kind === 'sso' ? a.email : (a.grant.email ?? a.grant.name ?? `grant:${a.grant.id}`) };
        },
    };
}
