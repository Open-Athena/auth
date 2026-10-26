/**
 * Sign in with an OIDC provider directly: the app's own sign-in page, no
 * hosted chooser in front of it and no per-seat identity product.
 *
 * Generic rather than Google-only: an issuer is four URLs, and `GOOGLE` is a
 * preset rather than a special case. Only the authorization-code flow, only
 * confidential clients (server-side, with a secret) — that's what a Worker or
 * Pages Function is.
 *
 * The two things that make this safe are both storage-free:
 *
 * - **state** is HMAC'd with the gate secret and carries the `next` path plus a
 *   nonce, so nothing has to be persisted between the two requests;
 * - **the nonce is double-submitted** — it rides in the signed state *and* in a
 *   short-lived cookie, and both must agree. Without that, a signed state an
 *   attacker minted from their own sign-in would be replayable against someone
 *   else's browser, which is login-CSRF: the victim ends up silently signed in
 *   as the attacker.
 */
import { b64uEncode } from '../core/base64.js';
import { RetainedLoginError } from '../core/retained.js';
import { verifyRs256Jwt } from '../core/jwt.js';
import { clearCookie, isSecureRequest, readCookie, sessionCookie, signSession, verifySession } from '../core/session.js';
import { generateToken } from '../core/tokens.js';
export const GOOGLE = {
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    jwksUrl: 'https://www.googleapis.com/oauth2/v3/certs',
    // Both are legitimate and which one you get has varied over time; rejecting
    // the bare form is a spurious sign-in failure nobody can debug from the logs.
    issuer: ['https://accounts.google.com', 'accounts.google.com'],
    scope: 'openid email profile',
};
const DEFAULT_NONCE_COOKIE = 'oa_oidc';
export const DEFAULT_ACCOUNT_HINT_COOKIE = 'oa_google_hint';
/** Chrome caps cookie lifetimes at 400 days. */
const ACCOUNT_HINT_TTL_S = 400 * 24 * 60 * 60;
const hintCookieName = (opt) => (opt === false ? null : (opt ?? DEFAULT_ACCOUNT_HINT_COOKIE));
function readAccountHint(req, name) {
    if (!name)
        return null;
    const raw = readCookie(req, name);
    if (!raw || raw.length > 3000)
        return null;
    try {
        return normalizeAccountHint(decodeURIComponent(raw));
    }
    catch {
        return null;
    }
}
function normalizeAccountHint(value) {
    if (typeof value !== 'string')
        return null;
    const email = value.trim().toLowerCase();
    return email.length <= 254 && /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(email) ? email : null;
}
function boundedAccountHints(values) {
    const emails = [];
    for (const value of values) {
        const email = normalizeAccountHint(value);
        if (!email || emails.includes(email))
            continue;
        if (encodeURIComponent(JSON.stringify([...emails, email])).length > 3000)
            break;
        emails.push(email);
        if (emails.length === 5)
            break;
    }
    return emails;
}
function readAccountHints(req, name) {
    if (!name)
        return [];
    const hint = readAccountHint(req, name);
    const raw = readCookie(req, `${name}_accounts`);
    let values = [];
    if (raw && raw.length <= 3000) {
        try {
            const parsed = JSON.parse(decodeURIComponent(raw));
            if (Array.isArray(parsed))
                values = parsed;
        }
        catch {
            // Malformed client-controlled history is an absent hint, not an error.
        }
    }
    return boundedAccountHints([hint, ...values]);
}
/** Remembered addresses are presentation hints, never retained sessions. */
function writeAccountHints(headers, req, name, email, denied = false) {
    if (!name)
        return;
    const normalized = normalizeAccountHint(email);
    const previous = readAccountHints(req, name);
    const accounts = denied
        ? previous.filter(value => value !== normalized)
        : boundedAccountHints([normalized, ...previous]);
    const current = denied ? accounts[0] : normalized;
    headers.append('set-cookie', current ? setAccountHint(req, name, current) : clearCookie({ name, secure: isSecureRequest(req) }));
    headers.append('set-cookie', accounts.length
        ? sessionCookie(encodeURIComponent(JSON.stringify(accounts)), { name: `${name}_accounts`, ttlS: ACCOUNT_HINT_TTL_S, secure: isSecureRequest(req) })
        : clearCookie({ name: `${name}_accounts`, secure: isSecureRequest(req) }));
}
const setAccountHint = (req, name, email) => sessionCookie(encodeURIComponent(email), { name, ttlS: ACCOUNT_HINT_TTL_S, secure: isSecureRequest(req) });
const STATE_PREFIX = 'oidc:';
/**
 * The PKCE verifier for a sign-in, derived rather than stored: an HMAC of its
 * nonce under the gate secret. Whoever sees the authorization request (which
 * carries only the S256 challenge) can't compute it; the callback, holding
 * the same nonce and secret, can. Storage-free, like `state`.
 */
async function pkceVerifier(secret, nonce) {
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return b64uEncode(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`pkce:${nonce}`)));
}
const pkceChallenge = async (verifier) => b64uEncode(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
/** Errors an authorization response may carry that mean "sign in some other way", not "attack". */
const SOFT_ERRORS = new Set(['login_required', 'interaction_required', 'account_selection_required', 'consent_required', 'access_denied']);
/** Only same-origin paths, so `?next=` can't become an open redirect. */
const safeNext = (raw) => (raw && raw.startsWith('/') && !raw.startsWith('//') ? raw : '/');
/**
 * Start the flow: mint a nonce, sign it into the state, and bounce to the
 * provider.
 *
 * The state is signed with the *session* secret but can never be presented as
 * a session: `parseSub` only accepts `e:`/`g:` subjects, and this one is
 * `oidc:`. The reverse holds too — a stolen session cookie is not a valid
 * state — so the two token types are mutually inert.
 */
export function oidcStart(opts) {
    const { gate, clientId, redirectUri, provider = GOOGLE, authParams = {}, stateTtlS = 600 } = opts;
    const nonceCookie = opts.nonceCookieName ?? DEFAULT_NONCE_COOKIE;
    const hintCookie = hintCookieName(opts.accountHintCookie);
    return async ({ request }) => {
        const nonce = generateToken();
        const params = new URL(request.url).searchParams;
        const next = safeNext(params.get('next'));
        const account = params.get('account');
        const choose = account === 'choose';
        const selected = normalizeAccountHint(account);
        const hint = choose ? null : account !== null
            ? selected && readAccountHints(request, hintCookie).includes(selected) ? selected : null
            : readAccountHint(request, hintCookie);
        const state = await signSession(`${STATE_PREFIX}${nonce}:${next}`, gate.secret, Date.now(), stateTtlS);
        // `?prompt=none`: a silent attempt (a broker that already knows this
        // browser answers with a code, or with `login_required`, never a page).
        const silent = params.get('prompt') === 'none';
        const url = new URL(provider.authUrl);
        url.search = new URLSearchParams({
            client_id: clientId,
            redirect_uri: redirectUri,
            response_type: 'code',
            scope: provider.scope,
            state,
            nonce,
            code_challenge: await pkceChallenge(await pkceVerifier(gate.secret, nonce)),
            code_challenge_method: 'S256',
            ...(hint ? { login_hint: hint } : {}),
            ...authParams,
            ...(choose ? { prompt: 'select_account' } : silent ? { prompt: 'none' } : {}),
        }).toString();
        return new Response(null, {
            status: 302,
            headers: {
                location: url.toString(),
                // `SameSite=Lax` still arrives on the provider's top-level redirect
                // back, which is the only place it needs to be readable.
                'set-cookie': sessionCookie(nonce, {
                    name: nonceCookie,
                    secure: isSecureRequest(request),
                    ttlS: stateTtlS,
                }),
                'cache-control': 'no-store',
            },
        });
    };
}
/**
 * Finish the flow: check the state and nonce, trade the code for an id_token,
 * verify it, and mint a session for the address it names.
 *
 * Every failure is a plain 400/401 with no detail, because everything here is
 * attacker-reachable and the differences between "bad state" and "bad nonce"
 * are only useful to whoever is probing.
 */
export function oidcCallback(opts) {
    const { gate, clientId, clientSecret, redirectUri, provider = GOOGLE, seedProfile = true } = opts;
    const nonceCookie = opts.nonceCookieName ?? DEFAULT_NONCE_COOKIE;
    const hintCookie = hintCookieName(opts.accountHintCookie);
    const doFetch = opts.fetch ?? globalThis.fetch;
    return async ({ request }) => {
        const url = new URL(request.url);
        const code = url.searchParams.get('code');
        const state = url.searchParams.get('state');
        const error = url.searchParams.get('error');
        if ((!code && !error) || !state)
            return deny('missing code or state');
        const sub = await verifySession(state, gate.secret, Date.now());
        if (!sub?.startsWith(STATE_PREFIX))
            return deny('bad state');
        const rest = sub.slice(STATE_PREFIX.length);
        const sep = rest.indexOf(':');
        if (sep < 0)
            return deny('bad state');
        const nonce = rest.slice(0, sep);
        const next = safeNext(rest.slice(sep + 1));
        // The double-submit. A valid signature proves *we* minted this state; the
        // cookie proves it was minted for *this browser*.
        const cookieNonce = readCookieValue(request, nonceCookie);
        if (!cookieNonce || cookieNonce !== nonce)
            return deny('state was not issued to this browser');
        // The provider declined (a silent attempt with no session there, say):
        // back to where the visitor was, told why, so the app offers a sign-in
        // button instead of trying again. Never a retry from here: that's a loop.
        if (error || !code) {
            const to = new URL(next, url.origin);
            to.searchParams.set('sso', error && SOFT_ERRORS.has(error) ? error : 'error');
            const headers = new Headers({ location: `${to.pathname}${to.search}`, 'cache-control': 'no-store' });
            headers.append('set-cookie', clearCookie({ name: nonceCookie, secure: isSecureRequest(request) }));
            return new Response(null, { status: 302, headers });
        }
        const token = await doFetch(provider.tokenUrl, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                code,
                client_id: clientId,
                client_secret: clientSecret,
                redirect_uri: redirectUri,
                grant_type: 'authorization_code',
                code_verifier: await pkceVerifier(gate.secret, nonce),
            }).toString(),
        })
            .then(r => (r.ok ? r.json() : null))
            .catch(() => null);
        if (!token?.id_token)
            return deny('token exchange failed');
        const claims = await verifyRs256Jwt(token.id_token, provider.jwksUrl, {
            issuer: provider.issuer,
            audience: clientId,
            fetch: doFetch,
        });
        if (!claims)
            return deny('id_token failed verification');
        // Replay protection: the id_token must answer the nonce *we* sent.
        if (claims.nonce !== nonce)
            return deny('id_token nonce mismatch');
        // An unverified address is a claim, not an identity — anyone can put
        // someone else's address on an account they haven't proved they own.
        if (claims.email_verified !== true || typeof claims.email !== 'string')
            return deny('no verified email');
        // A browser already holding as many logins as its gate retains can't take
        // another: back to the app, which can offer to remove one.
        const full = (e) => {
            if (!(e instanceof RetainedLoginError))
                throw e;
            const headers = new Headers({ location: `/?accounts=${e.code}`, 'cache-control': 'no-store' });
            headers.append('set-cookie', clearCookie({ name: nonceCookie, secure: isSecureRequest(request) }));
            return new Response(null, { status: 302, headers });
        };
        let signedIn;
        try {
            signedIn = await gate.signIn(claims.email, request);
        }
        catch (e) {
            return full(e);
        }
        // Authentication succeeded and authorization did not: the person is who
        // they say they are and still isn't allowed in. That distinction is what
        // lets an app pre-fill a request-access form with a *verified* address.
        if (!signedIn) {
            const headers = new Headers({ location: `/?denied=${encodeURIComponent(claims.email)}`, 'cache-control': 'no-store' });
            headers.append('set-cookie', clearCookie({ name: nonceCookie, secure: isSecureRequest(request) }));
            writeAccountHints(headers, request, hintCookie, claims.email, true);
            return new Response(null, { status: 302, headers });
        }
        // Seed name + face before we redirect, so the seeded subject is already
        // there on the browser's first `/whoami` (no initials flash, no cookie
        // reissue — the subject is re-derived per request). Best-effort: a failure
        // here must never turn a successful sign-in into an error.
        if (seedProfile)
            await gate.seedProfileFromClaims(claims.email, claims).catch(() => null);
        const headers = new Headers({ location: next, 'cache-control': 'no-store' });
        for (const c of signedIn.cookies)
            headers.append('set-cookie', c);
        headers.append('set-cookie', clearCookie({ name: nonceCookie, secure: isSecureRequest(request) }));
        writeAccountHints(headers, request, hintCookie, claims.email);
        return new Response(null, { status: 302, headers });
    };
}
const deny = (why) => new Response(`sign-in failed\n`, { status: 400, headers: { 'cache-control': 'no-store', 'x-oidc-reason': why } });
function readCookieValue(req, name) {
    const raw = req.headers.get('Cookie');
    if (!raw)
        return null;
    for (const part of raw.split(';')) {
        const i = part.indexOf('=');
        if (i > 0 && part.slice(0, i).trim() === name)
            return part.slice(i + 1).trim();
    }
    return null;
}
const ONETAP_PREFIX = 'onetap:';
/**
 * `GET` handler → `{ nonce, loginHint?, loginHints? }`. The page passes `nonce` to
 * `google.accounts.id.initialize({ nonce })` and echoes the same value back to
 * `googleOneTapVerify`. The value is opaque and single-window; it is not a
 * bearer credential (it authorizes nothing without a Google-signed id_token
 * that embeds it). `loginHint` is the remembered account (`AccountHintOptions`),
 * for the page to offer "not you?". Nonempty `loginHints` lists remembered
 * addresses for account rows; none of these hints authenticate a visitor.
 */
export function googleOneTapNonce(opts) {
    const { gate, ttlS = 300 } = opts;
    const hintCookie = hintCookieName(opts.accountHintCookie);
    return async (ctx) => {
        const nonce = await signSession(`${ONETAP_PREFIX}${generateToken()}`, gate.secret, Date.now(), ttlS);
        const loginHint = ctx?.request ? readAccountHint(ctx.request, hintCookie) : null;
        const loginHints = ctx?.request ? readAccountHints(ctx.request, hintCookie) : [];
        return new Response(JSON.stringify({ nonce, ...(loginHint ? { loginHint } : {}), ...(loginHints.length ? { loginHints } : {}) }) + '\n', {
            status: 200,
            headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
        });
    };
}
/** Every SHA-256 encoding Google might use for the nonce claim, plus the raw value. */
async function nonceForms(nonce) {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(nonce)));
    const b64u = b64uEncode(digest);
    const b64 = b64u.replace(/-/g, '+').replace(/_/g, '/');
    const hex = Array.from(digest, b => b.toString(16).padStart(2, '0')).join('');
    // Current GSI returns the raw nonce; the hashed forms cover the older
    // HTML-API behaviour. All derive from our signed nonce, so accepting several
    // encodings widens compatibility without weakening the binding.
    return new Set([nonce, b64u, b64, `${b64}=`, hex]);
}
/**
 * `POST {credential, nonce}` handler. `credential` is a Google id_token, `nonce`
 * the value from `googleOneTapNonce`. On success the session is signed into
 * *this* response (`200`) — the page is already where it wants to be, so unlike
 * the redirect flow there is nothing to redirect to. A verified-but-not-allowed
 * identity returns `401 {denied: <email>}` so the FE can pre-fill request-access
 * with the Google-verified address.
 */
export function googleOneTapVerify(opts) {
    const { gate, clientId, provider = GOOGLE, debug = false, seedProfile = true } = opts;
    const hintCookie = hintCookieName(opts.accountHintCookie);
    const doFetch = opts.fetch ?? globalThis.fetch;
    const deny = (why) => oneTapDeny(why, debug);
    return async ({ request }) => {
        const body = (await request.json().catch(() => ({})));
        const credential = typeof body.credential === 'string' ? body.credential : '';
        const nonce = typeof body.nonce === 'string' ? body.nonce : '';
        if (!credential || !nonce)
            return deny('missing credential or nonce');
        // The nonce must be one we minted and that hasn't expired.
        const sub = await verifySession(nonce, gate.secret, Date.now());
        if (!sub?.startsWith(ONETAP_PREFIX))
            return deny('bad nonce');
        const claims = await verifyRs256Jwt(credential, provider.jwksUrl, {
            issuer: provider.issuer,
            audience: clientId,
            fetch: doFetch,
        });
        if (!claims)
            return deny('credential failed verification');
        // The id_token must answer the nonce we handed the page.
        if (typeof claims.nonce !== 'string' || !(await nonceForms(nonce)).has(claims.nonce)) {
            return deny('nonce mismatch');
        }
        if (claims.email_verified !== true || typeof claims.email !== 'string')
            return deny('no verified email');
        let signedIn;
        try {
            signedIn = await gate.signIn(claims.email, request);
        }
        catch (e) {
            if (!(e instanceof RetainedLoginError))
                throw e;
            return new Response(JSON.stringify({ ok: false, error: e.code }) + '\n', {
                status: 409,
                headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
            });
        }
        if (!signedIn) {
            const headers = new Headers({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
            writeAccountHints(headers, request, hintCookie, claims.email, true);
            return new Response(JSON.stringify({ ok: false, denied: claims.email }) + '\n', { status: 401, headers });
        }
        // Seed before the 200: the FE re-fetches `/whoami` right after this resolves,
        // so awaiting the seed puts the name/face on that first poll. Best-effort.
        if (seedProfile)
            await gate.seedProfileFromClaims(claims.email, claims).catch(() => null);
        const headers = new Headers({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        for (const c of signedIn.cookies)
            headers.append('set-cookie', c);
        writeAccountHints(headers, request, hintCookie, claims.email);
        return new Response(JSON.stringify({ ok: true }) + '\n', { status: 200, headers });
    };
}
const oneTapDeny = (why, debug) => new Response(JSON.stringify({ ok: false }) + '\n', {
    status: 401,
    headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        ...(debug ? { 'x-onetap-reason': why } : {}),
    },
});
