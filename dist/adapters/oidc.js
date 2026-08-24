import { verifyRs256Jwt } from '../core/jwt.js';
import { clearCookie, isSecureRequest, sessionCookie, signSession, verifySession } from '../core/session.js';
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
const STATE_PREFIX = 'oidc:';
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
    return async ({ request }) => {
        const nonce = generateToken();
        const next = safeNext(new URL(request.url).searchParams.get('next'));
        const state = await signSession(`${STATE_PREFIX}${nonce}:${next}`, gate.secret, Date.now(), stateTtlS);
        const url = new URL(provider.authUrl);
        url.search = new URLSearchParams({
            client_id: clientId,
            redirect_uri: redirectUri,
            response_type: 'code',
            scope: provider.scope,
            state,
            nonce,
            ...authParams,
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
    const { gate, clientId, clientSecret, redirectUri, provider = GOOGLE } = opts;
    const nonceCookie = opts.nonceCookieName ?? DEFAULT_NONCE_COOKIE;
    const doFetch = opts.fetch ?? globalThis.fetch;
    return async ({ request }) => {
        const url = new URL(request.url);
        const code = url.searchParams.get('code');
        const state = url.searchParams.get('state');
        if (!code || !state)
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
        const token = await doFetch(provider.tokenUrl, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                code,
                client_id: clientId,
                client_secret: clientSecret,
                redirect_uri: redirectUri,
                grant_type: 'authorization_code',
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
        const signedIn = await gate.signIn(claims.email, request);
        // Authentication succeeded and authorization did not: the person is who
        // they say they are and still isn't allowed in. That distinction is what
        // lets an app pre-fill a request-access form with a *verified* address.
        if (!signedIn) {
            return new Response(null, {
                status: 302,
                headers: {
                    location: `/?denied=${encodeURIComponent(claims.email)}`,
                    'set-cookie': clearCookie({ name: nonceCookie, secure: isSecureRequest(request) }),
                    'cache-control': 'no-store',
                },
            });
        }
        const headers = new Headers({ location: next, 'cache-control': 'no-store' });
        headers.append('set-cookie', signedIn.cookie);
        headers.append('set-cookie', clearCookie({ name: nonceCookie, secure: isSecureRequest(request) }));
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
