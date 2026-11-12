/**
 * A small OpenID Connect provider over a gate: the gate's sign-in (Google,
 * emailed codes) and sessions are the provider's, and this turns "this browser
 * is signed in here as X" into an ID token for one of a fixed list of apps.
 *
 * Deliberately narrow (see `specs/oidc-provider.md`): authorization code with
 * PKCE S256 only, confidential clients from a registry, exact redirect URIs, no consent screen (every client is first-party), no refresh tokens.
 * The one exception to the last two is a PR-preview client (`ProviderClient.preview`): see `redirects.ts`.
 * What it leaves out it refuses, rather than half-supporting.
 */
import { b64uDecodeString, b64uEncode } from '../core/base64.js';
import { generateToken, hashToken } from '../core/tokens.js';
import { keySet } from './keys.js';
import { isHostedAvatar, pictureResponse, pictureTickets } from './picture.js';
import { redirectAllowed } from './redirects.js';
/** What a client registry stores in place of a secret. */
export const hashClientSecret = (secret) => hashToken(secret);
const STANDARD_SCOPES = ['openid', 'email', 'profile'];
/** Claims a `claims` hook may not set: they're the provider's to vouch for. */
const RESERVED = new Set(['iss', 'sub', 'aud', 'exp', 'iat', 'auth_time', 'nonce', 'azp', 'email', 'email_verified', 'name', 'picture', 'scope', 'client_id']);
/** RFC 7636: 43–128 unreserved characters. */
const VERIFIER = /^[A-Za-z0-9\-._~]{43,128}$/;
const CHALLENGE = /^[A-Za-z0-9\-_]{43}$/;
const PICTURE_PATH = '/picture/';
const enc = new TextEncoder();
const sec = (ms) => Math.floor(ms / 1000);
/** How long one click on the preview consent page lasts, and how many hosts a browser remembers. */
const PREVIEW_CONSENT_TTL_S = 7 * 86400;
const PREVIEW_CONSENT_MAX = 20;
const esc = (s) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body) + '\n', {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', pragma: 'no-cache', ...headers },
});
/** An error the browser sees here, because there's no trustworthy place to send it. */
const page = (status, message) => new Response(`${message}\n`, { status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
function cookieValue(req, name) {
    for (const part of (req.headers.get('cookie') ?? '').split(';')) {
        const i = part.indexOf('=');
        if (i > 0 && part.slice(0, i).trim() === name)
            return part.slice(i + 1).trim();
    }
    return null;
}
const redirect = (location, cookies = []) => {
    const headers = new Headers({ location, 'cache-control': 'no-store' });
    for (const c of cookies)
        headers.append('set-cookie', c);
    return new Response(null, { status: 302, headers });
};
async function hmac(secret, value) {
    const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return b64uEncode(await crypto.subtle.sign('HMAC', key, enc.encode(value)));
}
const s256 = async (verifier) => b64uEncode(await crypto.subtle.digest('SHA-256', enc.encode(verifier)));
/** Equal-length strings compared without an early exit. */
function same(a, b) {
    if (a.length !== b.length)
        return false;
    let d = 0;
    for (let i = 0; i < a.length; i++)
        d |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return d === 0;
}
export function oidcProviderRoutes(opts) {
    const { gate, store, subjectSecret, loginUrl, policy, tokenTtlS = 300, codeTtlS = 60 } = opts;
    const issuer = opts.issuer.replace(/\/+$/, '');
    const origin = new URL(issuer).origin;
    const base = (opts.basePath ?? '/oidc').replace(/\/+$/, '');
    const discoveryPath = `${new URL(issuer).pathname.replace(/\/+$/, '')}/.well-known/openid-configuration`;
    const endpoint = (p) => `${origin}${base}${p}`;
    const userinfoAud = endpoint('/userinfo');
    const clients = new Map(opts.clients.map(c => [c.id, c]));
    if (clients.size !== opts.clients.length)
        throw new Error('duplicate client id');
    const clientOf = async (id) => clients.get(id) ?? (id && opts.lookupClient ? await opts.lookupClient(id) : null);
    let keys = null;
    const ks = () => (keys ??= keySet(opts.keys));
    const scopesSupported = [...STANDARD_SCOPES, ...(opts.scopes ?? [])];
    const tickets = pictureTickets(subjectSecret);
    const secure = new URL(issuer).protocol === 'https:';
    const consentCookieName = `${secure ? '__Host-' : ''}oa_preview_ok`;
    /** The unexpired preview consents this browser carries, if its cookie is ours. */
    async function previewConsents(req, nowS) {
        const raw = cookieValue(req, consentCookieName);
        const dot = raw?.lastIndexOf('.') ?? -1;
        if (!raw || dot < 0)
            return [];
        const body = raw.slice(0, dot);
        if (!same(raw.slice(dot + 1), await hmac(subjectSecret, `preview-consent:${body}`)))
            return [];
        try {
            const list = JSON.parse(b64uDecodeString(body));
            return Array.isArray(list) ? list.filter(c => typeof c?.x === 'number' && c.x > nowS) : [];
        }
        catch {
            return [];
        }
    }
    async function previewConsentCookie(list) {
        const body = b64uEncode(enc.encode(JSON.stringify(list.slice(-PREVIEW_CONSENT_MAX))));
        const value = `${body}.${await hmac(subjectSecret, `preview-consent:${body}`)}`;
        return `${consentCookieName}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${PREVIEW_CONSENT_TTL_S}${secure ? '; Secure' : ''}`;
    }
    /** The one click a preview client needs: posts back to this same `/authorize` request. */
    function previewConsentPage(url, client, email, redirectUri) {
        const target = new URL(redirectUri);
        const app = client.name ?? client.id;
        const body = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in to a preview?</title>
<style>
:root { color-scheme: light dark; font-family: system-ui, sans-serif; }
body { margin: 0; padding: 16px; display: grid; place-items: center; min-height: 90vh; }
main { max-width: 32rem; }
.host { font-family: ui-monospace, monospace; overflow-wrap: anywhere; }
.muted { opacity: 0.7; font-size: 0.9em; }
button { font: inherit; padding: 0.5em 1.2em; margin-right: 0.5em; }
</style></head>
<body><main>
<h1>Sign in to a preview?</h1>
<p><strong class="host">${esc(target.host)}</strong> wants to sign you in as <strong>${esc(email)}</strong>.</p>
<p>It's a preview of ${esc(app)}, built from a branch whose code may not have been reviewed. Continue only if you meant to open it.</p>
<form method="post" action="${esc(`${url.pathname}${url.search}`)}">
<button name="decision" value="allow">Continue</button><button name="decision" value="deny">Cancel</button>
</form>
<p class="muted">You won't be asked again for this address for 7 days.</p>
</main></body></html>
`;
        return new Response(body, {
            status: 200,
            headers: {
                'content-type': 'text/html; charset=utf-8',
                'cache-control': 'no-store',
                'content-security-policy': `default-src 'none'; style-src 'unsafe-inline'; form-action 'self' ${target.origin}; frame-ancestors 'none'; base-uri 'none'`,
                'x-frame-options': 'DENY',
                // Not `no-referrer`: under it a browser sends `Origin: null` on the form's own POST, which
                // `authorize` must refuse. `same-origin` keeps the real Origin there, and still sends no
                // Referer (with the authorize URL's state and PKCE challenge) anywhere else.
                'referrer-policy': 'same-origin',
                'x-content-type-options': 'nosniff',
            },
        });
    }
    const discovery = () => ({
        issuer,
        authorization_endpoint: endpoint('/authorize'),
        token_endpoint: endpoint('/token'),
        userinfo_endpoint: userinfoAud,
        jwks_uri: endpoint('/jwks'),
        end_session_endpoint: endpoint('/logout'),
        response_types_supported: ['code'],
        response_modes_supported: ['query'],
        grant_types_supported: ['authorization_code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
        code_challenge_methods_supported: ['S256'],
        scopes_supported: scopesSupported,
        claims_supported: ['iss', 'sub', 'aud', 'exp', 'iat', 'nonce', 'email', 'email_verified', 'name', 'picture'],
        prompt_values_supported: ['none', 'select_account'],
        authorization_response_iss_parameter_supported: true,
        request_parameter_supported: false,
        request_uri_parameter_supported: false,
        claims_parameter_supported: false,
    });
    const subOf = (email) => hmac(subjectSecret, `e:${email}`);
    /** The standard claims for this person and scope set, plus the app's extras. */
    async function claimsFor(email, client, scopes) {
        const out = {};
        if (opts.claims) {
            for (const [k, v] of Object.entries(await opts.claims({ email, client, scopes })))
                if (!RESERVED.has(k))
                    out[k] = v;
        }
        if (scopes.includes('email'))
            Object.assign(out, { email, email_verified: true });
        if (scopes.includes('profile')) {
            const subject = await gate.subjectFor(email);
            if (subject?.name)
                out.name = subject.name;
            // Always a URL: an inline `data:` face would bloat every token.
            if (subject?.avatar && /^https:\/\//.test(subject.avatar))
                out.picture = subject.avatar;
            else if (subject?.avatar && isHostedAvatar(subject.avatar)) {
                const ticket = await tickets.seal({ email, clientId: client.id, expiresAt: sec(Date.now()) + tokenTtlS });
                out.picture = endpoint(`${PICTURE_PATH}${ticket}`);
            }
        }
        return out;
    }
    async function admitted(email, client) {
        if (policy && !(await policy({ email, client })))
            return false;
        if (client.allow && !(await client.allow(email)))
            return false;
        return true;
    }
    // ---- /authorize ----------------------------------------------------------
    async function authorize(req) {
        const url = new URL(req.url);
        const q = url.searchParams;
        // A POST is only the preview consent page's answer, and only from that page.
        let decision = null;
        if (req.method === 'POST') {
            if (req.headers.get('origin') !== origin)
                return page(403, 'This form has to come from this site.');
            decision = new URLSearchParams(await req.text()).get('decision');
            if (decision !== 'allow' && decision !== 'deny')
                return page(400, 'bad decision');
        }
        // Repeated parameters are ambiguous, and ambiguity is how parsers get split.
        for (const k of new Set(q.keys()))
            if (q.getAll(k).length > 1)
                return page(400, `repeated parameter: ${k}`);
        const client = await clientOf(q.get('client_id') ?? '');
        if (!client)
            return page(400, 'unknown client');
        const redirectUri = q.get('redirect_uri');
        // Exact, before anything is redirected: an unregistered URI must never
        // receive anything, an error included, or this is an open redirect.
        if (!redirectUri || !redirectAllowed(client.redirectUris, redirectUri, client.preview === true)) {
            return page(400, 'redirect_uri is not registered for this client');
        }
        if (decision !== null && !client.preview)
            return page(405, 'GET only');
        const state = q.get('state');
        const back = (params, cookies = []) => {
            const to = new URL(redirectUri);
            for (const [k, v] of Object.entries({ ...params, ...(state !== null ? { state } : {}), iss: issuer }))
                to.searchParams.set(k, v);
            return redirect(to.toString(), cookies);
        };
        const fail = (error, description) => back({ error, ...(description ? { error_description: description } : {}) });
        if (q.has('request') || q.has('request_uri'))
            return fail(q.has('request') ? 'request_not_supported' : 'request_uri_not_supported');
        if (q.get('response_type') !== 'code')
            return fail('unsupported_response_type');
        const scopes = (q.get('scope') ?? '').split(' ').filter(Boolean);
        if (!scopes.includes('openid'))
            return fail('invalid_scope', 'openid is required');
        const granted = scopes.filter(s => scopesSupported.includes(s));
        const challenge = q.get('code_challenge');
        const pkceOptional = client.requirePkce === false && challenge === null && !q.has('code_challenge_method');
        if (!pkceOptional && (!challenge || q.get('code_challenge_method') !== 'S256' || !CHALLENGE.test(challenge))) {
            return fail('invalid_request', 'PKCE with code_challenge_method=S256 is required');
        }
        const prompts = new Set((q.get('prompt') ?? '').split(' ').filter(Boolean));
        if (prompts.has('none') && prompts.size > 1)
            return fail('invalid_request', 'prompt=none must be alone');
        const maxAge = q.has('max_age') ? Number(q.get('max_age')) : null;
        if (maxAge !== null && !(Number.isInteger(maxAge) && maxAge >= 0))
            return fail('invalid_request', 'bad max_age');
        // A newly minted local session is not evidence of active upstream
        // authentication. Refuse freshness constraints until that proof is carried
        // through sign-in; redirecting to a chooser would only manufacture freshness.
        if (prompts.has('login') || maxAge !== null)
            return fail('login_required', 'Verified authentication freshness is not supported');
        const nowMs = Date.now();
        const nowS = sec(nowMs);
        const result = await gate.authenticateResult(req, nowMs, { logView: false });
        // Only a verified person at the broker vouches for anyone: a share-link
        // session here is a guest, and an app must never take it for an account.
        const email = result.auth?.kind === 'sso' ? result.auth.email : null;
        const wantChooser = prompts.has('select_account');
        if (!email || wantChooser) {
            // No one selected (or a guest), but the browser holds verified accounts
            // here: a choice is what's missing, not a sign-in.
            const choosable = !email && gate.retained
                ? ((await gate.retained.accounts(req, nowMs))?.accounts ?? []).some(a => a.kind === 'sso')
                : false;
            if (prompts.has('none'))
                return fail(choosable ? 'account_selection_required' : 'login_required');
            // Account selection is not reauthentication; don't repeat the chooser.
            const next = new URL(url);
            next.searchParams.delete('prompt');
            const to = new URL(loginUrl, origin);
            to.searchParams.set('next', `${next.pathname}${next.search}`);
            if (wantChooser || choosable)
                to.searchParams.set('prompt', 'select_account');
            const hint = q.get('login_hint');
            if (hint)
                to.searchParams.set('login_hint', hint);
            return redirect(to.toString());
        }
        if (!(await admitted(email, client)))
            return fail('access_denied');
        // A preview is unreviewed code: one click per host before it learns who this is.
        const cookies = [];
        if (client.preview) {
            const host = new URL(redirectUri).host;
            const sub = await subOf(email);
            const held = await previewConsents(req, nowS);
            const mine = (c) => c.s === sub && c.c === client.id && c.h === host;
            if (!held.some(mine)) {
                if (decision === 'deny')
                    return fail('access_denied');
                if (decision !== 'allow')
                    return prompts.has('none') ? fail('interaction_required') : previewConsentPage(url, client, email, redirectUri);
                cookies.push(await previewConsentCookie([...held.filter(c => !mine(c)), { s: sub, c: client.id, h: host, x: nowS + PREVIEW_CONSENT_TTL_S }]));
            }
        }
        const code = generateToken();
        await store.putCode({
            codeHash: await hashToken(code),
            clientId: client.id,
            redirectUri,
            // '' for a client allowed to skip PKCE that did: its exchange must then send no verifier.
            challenge: challenge ?? '',
            nonce: q.get('nonce'),
            email,
            scope: granted.join(' '),
            authTime: null,
            expiresAt: nowS + codeTtlS,
        });
        return back({ code }, cookies);
    }
    // ---- /token --------------------------------------------------------------
    /** The authenticated client, or the error response. */
    async function clientAuth(req, form) {
        const basic = req.headers.get('authorization')?.match(/^Basic\s+(.+)$/i);
        const invalid = (status = 401) => json({ error: 'invalid_client' }, status, basic ? { 'www-authenticate': 'Basic realm="token"' } : {});
        let id;
        let secret;
        if (basic) {
            if (form.has('client_secret'))
                return json({ error: 'invalid_request', error_description: 'one client authentication method' }, 400);
            let decoded;
            try {
                decoded = atob(basic[1]);
            }
            catch {
                return invalid();
            }
            const i = decoded.indexOf(':');
            if (i < 0)
                return invalid();
            // RFC 6749 §2.3.1: both halves are form-urlencoded inside the header.
            try {
                id = decodeURIComponent(decoded.slice(0, i).replace(/\+/g, ' '));
                secret = decodeURIComponent(decoded.slice(i + 1).replace(/\+/g, ' '));
            }
            catch {
                return invalid();
            }
            if (form.has('client_id') && form.get('client_id') !== id)
                return invalid();
        }
        else {
            id = form.get('client_id');
            secret = form.get('client_secret');
        }
        const client = await clientOf(id ?? '');
        if (!client || !secret)
            return invalid();
        if (!same(await hashClientSecret(secret), client.secretHash))
            return invalid();
        return client;
    }
    async function token(req) {
        if (req.method !== 'POST')
            return json({ error: 'invalid_request' }, 405, { allow: 'POST' });
        if (!(req.headers.get('content-type') ?? '').startsWith('application/x-www-form-urlencoded')) {
            return json({ error: 'invalid_request', error_description: 'form-encoded body required' }, 400);
        }
        const form = new URLSearchParams(await req.text());
        for (const k of new Set(form.keys()))
            if (form.getAll(k).length > 1)
                return json({ error: 'invalid_request' }, 400);
        const client = await clientAuth(req, form);
        if (client instanceof Response)
            return client;
        if (form.get('grant_type') !== 'authorization_code')
            return json({ error: 'unsupported_grant_type' }, 400);
        const code = form.get('code');
        const verifier = form.get('code_verifier');
        if (!code)
            return json({ error: 'invalid_request' }, 400);
        const nowS = sec(Date.now());
        // Taken before any check: a code is spent by any attempt to use it, so a
        // stolen one is worth at most one guess.
        const codeHash = await hashToken(code);
        const rec = await store.takeCode(codeHash, nowS);
        // OAuth 2.0 §4.1.2: a code seen again means one of the two exchanges wasn't
        // the app, so the token from the first stops working. An ID token already
        // issued can't be recalled: it's the app's, and short-lived.
        if (rec)
            await store.noteSpent(codeHash, nowS + tokenTtlS);
        else
            await store.revokeSpent(codeHash);
        if (!rec ||
            rec.clientId !== client.id ||
            rec.redirectUri !== form.get('redirect_uri') ||
            (rec.challenge === ''
                ? verifier !== null
                : verifier === null || !VERIFIER.test(verifier) || !same(await s256(verifier), rec.challenge))) {
            return json({ error: 'invalid_grant' }, 400);
        }
        // Re-checked at exchange: someone delisted in the last minute is refused.
        if (!(await admitted(rec.email, client)))
            return json({ error: 'invalid_grant' }, 400);
        if (Math.random() < 0.05)
            await store.cleanup(nowS).catch(() => 0);
        const scopes = rec.scope.split(' ').filter(Boolean);
        const sub = await subOf(rec.email);
        const extra = await claimsFor(rec.email, client, scopes);
        const idToken = await ks().sign({
            ...extra,
            iss: issuer,
            sub,
            aud: client.id,
            iat: nowS,
            exp: nowS + tokenTtlS,
            ...(rec.nonce !== null ? { nonce: rec.nonce } : {}),
        });
        const accessToken = await ks().sign({ iss: issuer, sub, aud: userinfoAud, client_id: client.id, scope: rec.scope, email: rec.email, jti: codeHash, iat: nowS, exp: nowS + tokenTtlS }, 'at+jwt');
        return json({ access_token: accessToken, token_type: 'Bearer', expires_in: tokenTtlS, id_token: idToken, scope: rec.scope });
    }
    // ---- /userinfo -----------------------------------------------------------
    async function userinfo(req) {
        const bearer = req.headers.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];
        const challenge = (error) => json({ error }, 401, { 'www-authenticate': `Bearer error="${error}"` });
        if (!bearer)
            return json({ error: 'invalid_request' }, 401, { 'www-authenticate': 'Bearer' });
        const at = await ks().verify(bearer);
        const nowS = sec(Date.now());
        if (!at ||
            at.iss !== issuer ||
            at.aud !== userinfoAud ||
            typeof at.exp !== 'number' ||
            at.exp <= nowS ||
            typeof at.sub !== 'string' ||
            typeof at.email !== 'string' ||
            typeof at.scope !== 'string') {
            return challenge('invalid_token');
        }
        if (typeof at.jti === 'string' && (await store.isSpentRevoked(at.jti)))
            return challenge('invalid_token');
        const client = await clientOf(String(at.client_id));
        if (!client || !(await admitted(at.email, client)))
            return challenge('invalid_token');
        return json({ ...(await claimsFor(at.email, client, at.scope.split(' '))), sub: at.sub });
    }
    // ---- /picture/<ticket> ---------------------------------------------------
    /**
     * The face a `picture` claim points at (`picture.ts`). No session: an app's
     * server fetches this. One answer for every refusal, so it says nothing about
     * whether a ticket was once good or who it's for.
     */
    async function picture(ticket) {
        const missing = () => page(404, 'not found');
        const t = await tickets.open(ticket);
        if (!t || t.expiresAt <= sec(Date.now()))
            return missing();
        const client = await clientOf(t.clientId);
        if (!client || !(await admitted(t.email, client)))
            return missing();
        const avatar = (await gate.subjectFor(t.email))?.avatar;
        return (avatar && (await pictureResponse(avatar, id => gate.getAsset(id)))) || missing();
    }
    // ---- /logout -------------------------------------------------------------
    async function logout(req) {
        const params = req.method === 'POST' && (req.headers.get('content-type') ?? '').startsWith('application/x-www-form-urlencoded')
            ? new URLSearchParams(await req.text())
            : new URL(req.url).searchParams;
        const hint = params.get('id_token_hint');
        // An expired hint is still evidence of which app is asking (OIDC
        // RP-Initiated Logout §2): only the signature and issuer are checked.
        const claims = hint ? await ks().verify(hint) : null;
        const client = claims && claims.iss === issuer ? await clientOf(String(claims.aud)) : null;
        const postLogout = params.get('post_logout_redirect_uri');
        const cookies = await gate.signOutCookies(req);
        if (client && postLogout && redirectAllowed(client.postLogoutRedirectUris ?? [], postLogout, client.preview === true)) {
            const to = new URL(postLogout);
            const state = params.get('state');
            if (state !== null)
                to.searchParams.set('state', state);
            return redirect(to.toString(), cookies);
        }
        const headers = new Headers({ 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
        for (const c of cookies)
            headers.append('set-cookie', c);
        return new Response('Signed out.\n', { status: 200, headers });
    }
    return async (req) => {
        const path = new URL(req.url).pathname;
        if (path === discoveryPath && req.method === 'GET')
            return json(discovery(), 200, { 'cache-control': 'public, max-age=300' });
        if (!path.startsWith(`${base}/`))
            return null;
        if (path.startsWith(`${base}${PICTURE_PATH}`)) {
            return req.method === 'GET' ? picture(path.slice(`${base}${PICTURE_PATH}`.length)) : page(405, 'GET only');
        }
        switch (path.slice(base.length)) {
            case '/jwks':
                return json(ks().jwks, 200, { 'cache-control': 'public, max-age=300' });
            case '/authorize':
                return req.method === 'GET' || req.method === 'POST' ? authorize(req) : page(405, 'GET or POST only');
            case '/token':
                return token(req);
            case '/userinfo':
                return req.method === 'GET' || req.method === 'POST' ? userinfo(req) : json({ error: 'invalid_request' }, 405);
            case '/logout':
                return logout(req);
            default:
                return null;
        }
    };
}
/** For an app: the broker as an `OidcProvider` (`@open-athena/auth/oidc`), from its issuer. */
export function brokerProvider(issuer, { basePath = '/oidc', scope = 'openid email profile' } = {}) {
    const iss = issuer.replace(/\/+$/, '');
    const origin = new URL(iss).origin;
    return {
        authUrl: `${origin}${basePath}/authorize`,
        tokenUrl: `${origin}${basePath}/token`,
        jwksUrl: `${origin}${basePath}/jwks`,
        issuer: iss,
        scope,
    };
}
