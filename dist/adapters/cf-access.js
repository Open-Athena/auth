import { verifyRs256Jwt } from '../core/jwt.js';
import { emailSub, isSecureRequest, sessionCookie, signSession } from '../core/session.js';
const enc = new TextEncoder();
/**
 * Verify an Access JWT against the Zero Trust team's public certs and return
 * the authenticated email, or null. `aud` is checked when `expectedAud` is
 * given — do give it: without it any app in the same team is accepted.
 */
export async function verifyAccessJwt(jwt, teamDomain, expectedAud, nowMs = Date.now()) {
    const claims = await verifyRs256Jwt(jwt, `${teamDomain}/cdn-cgi/access/certs`, {
        issuer: teamDomain,
        audience: expectedAud,
        nowMs,
    });
    return typeof claims?.email === 'string' ? claims.email : null;
}
/** Reject absolute and protocol-relative `next` values — an open redirect off a login path. */
function safeNext(raw) {
    return raw && raw.startsWith('/') && !raw.startsWith('//') ? raw : '/';
}
/**
 * Build the `/auth/sso` handler: verify Access -> mint session -> 302 to `next`.
 * Usable directly as a Pages Function `onRequest`.
 */
export function ssoHandler({ gate, teamDomain, aud }) {
    return async ({ request }) => {
        const email = await accessEmail(request, teamDomain, aud);
        if (email instanceof Response)
            return email;
        const signedIn = await gate.signIn(email, request);
        if (!signedIn)
            return new Response(`${email} is not authorized for this app\n`, { status: 403 });
        return bounce(request, signedIn.cookie);
    };
}
/**
 * `ssoHandler` without a gate — for a deployment that can mint sessions but
 * can't verify them, because the store lives somewhere else. watchy's Pages
 * project is the case: its `/auth/sso` is the only Access-gated path, but the
 * auth authority (and D1 binding) is a separate Worker, so taking a whole gate
 * costs it a binding it has no other use for.
 *
 * Safe because a session cookie carries no authorization: the claim is only
 * `e:<email>`, and scopes are re-derived from `policy` on every `authenticate`.
 * So this mints for any Access-verified email and the gate decides later —
 * the same order of operations `ssoHandler` uses, minus the early rejection
 * (and minus the `signin` audit row, which needs the gate's sink).
 */
export function ssoSessionHandler({ secret, teamDomain, aud, cookieName, sessionTtlS }) {
    return async ({ request }) => {
        const email = await accessEmail(request, teamDomain, aud);
        if (email instanceof Response)
            return email;
        const value = await signSession(emailSub(email), secret, Date.now(), sessionTtlS);
        return bounce(request, sessionCookie(value, { name: cookieName, secure: isSecureRequest(request), ttlS: sessionTtlS }));
    };
}
/** The Access identity, or the response to return instead. */
async function accessEmail(request, teamDomain, aud) {
    const jwt = request.headers.get('Cf-Access-Jwt-Assertion');
    if (!jwt)
        return new Response('no Access JWT — is this path still gated?\n', { status: 401 });
    const email = await verifyAccessJwt(jwt, teamDomain, aud);
    if (!email)
        return new Response('Access JWT failed verification\n', { status: 401 });
    return email;
}
const bounce = (request, cookie) => new Response(null, {
    status: 302,
    headers: {
        location: safeNext(new URL(request.url).searchParams.get('next')),
        'set-cookie': cookie,
        'cache-control': 'no-store',
    },
});
