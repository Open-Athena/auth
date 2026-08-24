/**
 * A mountable `/api/auth/*` surface, so a consumer wires the gate up instead of
 * re-deriving watchy's `auth.ts` by hand. Returns `null` for paths it doesn't
 * own, so an app can fall through to its own router.
 *
 * Everything here is presentation-free JSON: the wall, the admin table and the
 * copy around them are per-app and get vendored, per share-links §6.
 */
import { renderDecisionPage } from './decision-page.js';
import { isSafeAvatarUrl, resolveAvatar } from './avatar.js';
import { cleanSubject } from './requests.js';
import { hasScope } from './types.js';
/**
 * Every response here is identity-shaped — who you are, which links are yours,
 * who asked for access — so none of it may be stored by anything between the
 * worker and the browser. Nothing caches these today (CF reports `DYNAMIC`),
 * but an identity endpoint a proxy *could* hand to the wrong person is a bad
 * thing to leave to heuristics when the fix is one header.
 */
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data, null, 2) + '\n', {
    status,
    headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        ...headers,
    },
});
async function body(req) {
    return (await req.json().catch(() => ({})));
}
/**
 * The decision page posts a real `<form>`, so this endpoint has to read
 * `application/x-www-form-urlencoded` as well as JSON — a mail client is not
 * going to send `fetch` with a JSON body.
 */
async function formOrJson(req) {
    const ct = req.headers.get('content-type') ?? '';
    if (ct.includes('json'))
        return (await req.json().catch(() => ({})));
    const form = await req.formData().catch(() => null);
    if (!form)
        return {};
    return Object.fromEntries([...form.entries()].map(([k, v]) => [k, String(v)]));
}
const defaultCreator = (auth) => (auth.kind === 'sso' ? auth.email : `g:${auth.grant.id}`);
export function authRoutes(gate, opts = {}) {
    const { basePath = '/api/auth', adminScope = 'admin', audit, creatorOf = defaultCreator, scopeToCreator, honeypotField = 'website', avatarLookup = false, decisionPage, decisionAppName, } = opts;
    return async function handle(req) {
        const url = new URL(req.url);
        if (url.pathname !== basePath && !url.pathname.startsWith(`${basePath}/`))
            return null;
        const rest = url.pathname.slice(basePath.length) || '/';
        const method = req.method;
        const seg = rest.split('/').filter(Boolean);
        // Resolve identity once per request; admin routes then re-check the scope.
        // `logView: false` because these endpoints are plumbing, not pages — a view
        // row per `/whoami` poll would bury the routes a visitor actually read.
        const auth = await gate.authenticate(req, undefined, { logView: false });
        const require = async (scope) => {
            if (!auth)
                return json({ error: 'unauthenticated' }, 401);
            if (!hasScope(auth, scope))
                return json({ error: 'forbidden' }, 403);
            return auth;
        };
        const admin = () => require(adminScope);
        const listFilter = (a) => (scopeToCreator ? { createdBy: scopeToCreator(a) } : {});
        // ---- public -------------------------------------------------------------
        if (rest === '/whoami' && method === 'GET') {
            return auth ? json(gate.whoami(auth)) : json({ error: 'unauthenticated' }, 401);
        }
        if (rest === '/exchange' && method === 'POST') {
            const { token } = await body(req);
            if (!token)
                return json({ error: 'token required' }, 400);
            const res = await gate.redeem(token, req);
            if (!res.ok)
                return json({ error: 'invalid link', reason: res.reason }, 401);
            return json(gate.whoami(res.auth), 200, { 'set-cookie': res.cookie });
        }
        if (rest === '/logout' && method === 'POST') {
            return json({ ok: true }, 200, { 'set-cookie': await gate.signOut(req, auth) });
        }
        /**
         * First-party beacon for client-only signals — SPA route changes above all,
         * which no server request would otherwise reveal. Same store as everything
         * else, so "who viewed what" still joins to `grants` natively; no
         * third-party script, and no cookie banner, since the only cookie involved
         * is the session the visitor already has.
         */
        if (rest === '/track' && method === 'POST') {
            if (!auth)
                return json({ ok: true }); // anonymous beacons are simply dropped
            const { path } = await body(req);
            // A client-supplied path is untrusted input that lands in an admin's
            // table: take same-origin paths only, and cap the length.
            if (!path || !path.startsWith('/') || path.startsWith('//') || path.length > 512) {
                return json({ error: 'path must be a same-origin path' }, 400);
            }
            await gate.logView(req, auth, undefined, path);
            return json({ ok: true });
        }
        if (rest === '/request' && method === 'POST') {
            const input = await body(req);
            // A filled honeypot gets the same answer a human gets: no signal back to
            // the bot about what tripped, and no row to clean up.
            if (input[honeypotField])
                return json({ status: 'pending' });
            if (!input.email)
                return json({ error: 'email required' }, 400);
            // `cleanSubject` caps and strips these: they are attacker-controlled
            // strings destined for a table an admin reads.
            const res = await gate.requestAccess({
                email: input.email,
                name: input.name,
                note: input.note,
                subject: cleanSubject({ first: input.first, last: input.last }),
            }, req);
            if (res.status === 'invalid')
                return json({ status: 'invalid', error: "that doesn't look like an email address" }, 400);
            if (res.status === 'rate-limited')
                return json({ status: 'rate-limited', error: 'too many requests; try later' }, 429);
            // Never echo the request id or token back to an unauthenticated submitter.
            return json({ status: res.status });
        }
        // Decision links, reached from a mail client. GET renders a confirmation
        // page and commits nothing — mail scanners (Outlook Safe Links, corporate
        // gateways, antivirus) fetch every URL in a message, and a GET that decided
        // would let them approve requests in an admin's name. POST commits.
        if (rest === '/decide' && (method === 'GET' || method === 'POST')) {
            const token = method === 'GET' ? (url.searchParams.get('t') ?? '') : ((await formOrJson(req)).t ?? '');
            const view = await gate.decide(token, {
                commit: method === 'POST',
                // Only ever an authenticated admin; `requireAuth` decides whether the
                // absence of one is fatal.
                actor: auth && hasScope(auth, adminScope) && auth.kind === 'sso' ? auth.email : null,
            });
            const render = decisionPage ?? renderDecisionPage;
            return render(view, { appName: decisionAppName, action: `${basePath}/decide` });
        }
        // ---- admin --------------------------------------------------------------
        if (seg[0] === 'grants') {
            const a = await admin();
            if (a instanceof Response)
                return a;
            if (seg.length === 1 && method === 'GET') {
                // Revoked grants stay in the list by default: this is the ledger an
                // admin reads, and a row vanishing on revoke is indistinguishable from
                // a delete — it hides exactly the history revocation is evidence of.
                // `?active=1` opts out. (The *store* still defaults to active-only,
                // which is the right default for a gate check.)
                const includeRevoked = url.searchParams.get('active') !== '1';
                return json({ grants: await gate.list({ includeRevoked, ...listFilter(a) }) });
            }
            if (seg.length === 1 && method === 'POST') {
                const b = await body(req);
                if (!b.scopes?.length)
                    return json({ error: 'scopes required' }, 400);
                // Unlike the request form, the supplier here is an admin, so an avatar
                // *is* accepted — still `https:`-only, since the value lands in an
                // `<img src>` on every recipient's page.
                const subject = cleanSubject({ first: b.first, last: b.last });
                const avatar = b.avatar && isSafeAvatarUrl(b.avatar) ? b.avatar : null;
                const { grant, token } = await gate.mint({
                    name: b.name ?? null,
                    note: b.note ?? null,
                    email: b.email ?? null,
                    subject: avatar ? { ...subject, avatar } : subject,
                    scopes: b.scopes,
                    maxRedeems: b.maxRedeems ?? null,
                    expiresAt: b.expiresInS ? Math.floor(Date.now() / 1000) + b.expiresInS : null,
                    sessionTtlS: b.sessionTtlS ?? null,
                    expiryEndsSessions: b.expiryEndsSessions ?? true,
                    createdBy: creatorOf(a),
                });
                // The only time the raw token is ever visible.
                return json({ grant, token });
            }
            const id = seg[1];
            if (id && seg[2] === 'revoke' && method === 'POST') {
                const owned = await ownedGrant(id, a);
                if (owned instanceof Response)
                    return owned;
                return json({ ok: await gate.revoke(id) });
            }
            // Disable/enable are the reversible half: they stop new redemptions and
            // leave anyone already reading the page alone.
            if (id && (seg[2] === 'disable' || seg[2] === 'enable') && method === 'POST') {
                const owned = await ownedGrant(id, a);
                if (owned instanceof Response)
                    return owned;
                return json({ ok: seg[2] === 'disable' ? await gate.disable(id) : await gate.enable(id) });
            }
            if (id && seg.length === 2 && method === 'PATCH') {
                const owned = await ownedGrant(id, a);
                if (owned instanceof Response)
                    return owned;
                const b = await body(req);
                // Whitelisted, not spread: a PATCH body is admin-supplied but still
                // untrusted structure, and `scopes`/`createdBy` are not negotiable
                // after minting.
                const patch = {};
                if ('name' in b)
                    patch.name = b.name ?? null;
                if ('note' in b)
                    patch.note = b.note ?? null;
                if ('expiresAt' in b)
                    patch.expiresAt = b.expiresAt ?? null;
                if ('maxRedeems' in b)
                    patch.maxRedeems = b.maxRedeems ?? null;
                if ('sessionTtlS' in b)
                    patch.sessionTtlS = b.sessionTtlS ?? null;
                if ('expiryEndsSessions' in b)
                    patch.expiryEndsSessions = !!b.expiryEndsSessions;
                const grant = await gate.update(id, patch);
                return grant ? json({ grant }) : json({ error: 'not found' }, 404);
            }
            if (id && seg[2] === 'activity' && method === 'GET') {
                if (!audit)
                    return json({ error: 'audit query not configured' }, 501);
                const owned = await ownedGrant(id, a);
                if (owned instanceof Response)
                    return owned;
                return json(await audit.activity(id));
            }
        }
        if (seg[0] === 'requests') {
            const a = await require(opts.requestScope ?? adminScope);
            if (a instanceof Response)
                return a;
            if (seg.length === 1 && method === 'GET') {
                const status = url.searchParams.get('status');
                return json({ requests: await gate.listRequests(status ? { status } : undefined) });
            }
            const id = seg[1];
            if (id && seg[2] === 'approve' && method === 'POST') {
                const b = await body(req);
                const res = await gate.approveRequest(id, creatorOf(a), { scopes: b.scopes });
                if (!res)
                    return json({ error: 'no pending request with that id' }, 404);
                return json({ request: res.request, grant: res.grant, token: res.token });
            }
            if (id && seg[2] === 'deny' && method === 'POST') {
                const request = await gate.denyRequest(id, creatorOf(a));
                if (!request)
                    return json({ error: 'no pending request with that id' }, 404);
                return json({ request });
            }
        }
        if (rest === '/avatar' && method === 'POST') {
            const a = await admin();
            if (a instanceof Response)
                return a;
            if (!avatarLookup)
                return json({ error: 'avatar lookup not configured' }, 501);
            const b = await body(req);
            const opts = typeof avatarLookup === 'object' ? avatarLookup : {};
            return json({ avatar: await resolveAvatar({ email: b.email, github: b.github, url: b.url }, opts) });
        }
        if (rest === '/log' && method === 'GET') {
            const a = await admin();
            if (a instanceof Response)
                return a;
            if (!audit)
                return json({ error: 'audit query not configured' }, 501);
            const grantId = url.searchParams.get('grant') ?? undefined;
            const limit = Number(url.searchParams.get('limit')) || 100;
            return json({ events: await audit.recent({ grantId, limit, ...listFilter(a) }) });
        }
        return json({ error: 'not found' }, 404);
        /** 404 (not 403) for someone else's grant: don't confirm that an id exists. */
        async function ownedGrant(id, a) {
            if (!scopeToCreator)
                return true;
            const mine = await gate.list({ includeRevoked: true, createdBy: scopeToCreator(a) });
            return mine.some(g => g.id === id) ? true : json({ error: 'not found' }, 404);
        }
    };
}
