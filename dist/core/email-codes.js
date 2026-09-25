/**
 * Passwordless email sign-in for addresses that can't (or won't) use Google.
 *
 * One pending-auth row backs two ways to prove control of an inbox, the Slack
 * pattern:
 *
 *  - a **magic link** (`verifyLink`) — the happy path, signs in whatever
 *    browser opens it;
 *  - a **6-digit code** (`verifyCode`) — typed back into the original tab, which
 *    is what rescues the cross-device case (the mail is on your phone, the tab
 *    is on your laptop) and survives link-prefetching security scanners that
 *    would consume a single-use URL before the human ever clicks it.
 *
 * Both the token and the code are stored hashed (SHA-256, like a grant token),
 * the row is single-use and short-lived, and the code's guess count is capped.
 * Nothing here is persisted beyond the row — the session it ultimately mints is
 * an ordinary `gate.signIn`, so revocation, TTL and scopes are unchanged.
 *
 * These are mountable handlers (`({ request }) => Response`), the same shape as
 * the OIDC adapter's `oidcStart`/`oidcCallback`, so a consumer wires them as
 * Functions at whatever paths it likes.
 */
import { requestMeta } from './audit.js';
import { generateId, generateToken, hashToken } from './tokens.js';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const enc = new TextEncoder();
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data) + '\n', {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
});
/** A uniform 6-digit code. Rejection-sampled so `% 1e6` carries no modulo bias. */
function sixDigitCode() {
    const buf = new Uint32Array(1);
    let n;
    // 4_000_000_000 is the largest multiple of 1e6 below 2^32; rejecting above it
    // leaves a range that divides evenly, so every code is equally likely.
    do {
        crypto.getRandomValues(buf);
        n = buf[0];
    } while (n >= 4_000_000_000);
    return String(n % 1_000_000).padStart(6, '0');
}
const hashCode = (email, code) => hashToken(`${email}:${code}`);
/** Only same-origin paths, so a link's `?next=` can't become an open redirect. */
const safeNext = (raw, fallback) => raw && raw.startsWith('/') && !raw.startsWith('//') ? raw : fallback;
/** A live row, or null: covers absent, already-consumed, and expired identically. */
function usable(row, nowS) {
    if (!row || row.consumedAt !== null || row.expiresAt <= nowS)
        return null;
    return row;
}
export function emailCodeAuth(opts) {
    const { gate, store, send, from, linkFor, appName = 'this site', ttlS = 900, maxAttempts = 5, defaultNext = '/', nowMs = Date.now, } = opts;
    const windowS = opts.rateLimit?.windowS ?? 900;
    const maxPerEmail = opts.rateLimit?.maxPerEmail ?? 3;
    const maxPerIp = opts.rateLimit?.maxPerIp ?? 10;
    const sec = (ms) => Math.floor(ms / 1000);
    /**
     * Begin a sign-in: mail a link + code to `email`, but only if the gate would
     * admit it. The response is identical for allowed and not-allowed addresses
     * (and for a rate-limited one) so an anonymous caller can't probe the
     * allowlist — a not-allowed address simply never receives mail, and its `id`
     * names a flow that no code will ever satisfy. The UI offers request-access
     * alongside, which is where a genuinely-not-allowed person goes.
     *
     * Pass `waitUntil` (the Pages Function context has it) so the mail send is
     * scheduled rather than awaited: otherwise the admitted path blocks on
     * delivery while the early-return paths don't, and that latency gap is itself
     * a (coarse) allowlist oracle. Without it, delivery is awaited inline.
     */
    async function start({ request, waitUntil, }) {
        const body = (await request.json().catch(() => ({})));
        const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
        // A malformed address is a client error, not an allowlist signal, so it may
        // answer differently.
        if (!EMAIL_RE.test(email))
            return json({ status: 'invalid-email' }, 400);
        const nowS = sec(nowMs());
        const constant = { status: 'sent', id: generateId() };
        const { ipHash } = await requestMeta(request, gate.secret);
        const recent = await store.countSince(email, nowS - windowS);
        if (recent >= maxPerEmail)
            return json(constant);
        // Per-IP cap: only meaningful once an IP is known. Rows exist only for
        // admitted addresses, so this bounds how fast one source can fan mail out
        // across the allowlist, not anonymous probing (which sends nothing).
        if (ipHash && (await store.countSinceByIp(ipHash, nowS - windowS)) >= maxPerIp)
            return json(constant);
        const scopes = await gate.admits(email);
        if (!scopes)
            return json(constant);
        const token = generateToken();
        const code = sixDigitCode();
        const row = {
            id: constant.id,
            email,
            tokenHash: await hashToken(token),
            codeHash: await hashCode(email, code),
            createdAt: nowS,
            expiresAt: nowS + ttlS,
            consumedAt: null,
            attempts: 0,
            ipHash,
        };
        await store.insert(row);
        const minutes = Math.round(ttlS / 60);
        const link = linkFor(token);
        const deliver = send({
            from,
            to: email,
            subject: `Your sign-in code for ${appName}`,
            text: [
                `Here's your sign-in for ${appName}.`,
                ``,
                `Enter this code where you started:`,
                ``,
                `    ${code}`,
                ``,
                `Or open this link on this device:`,
                ``,
                link,
                ``,
                `The code and link both expire in ${minutes} minutes and can be used once.`,
                `If you didn't ask to sign in, you can ignore this email.`,
            ].join('\n'),
        }).catch(() => { });
        // Scheduled (constant-latency) when the runtime gives us `waitUntil`, else
        // awaited so the send still happens before the worker is torn down.
        if (waitUntil)
            waitUntil(deliver);
        else
            await deliver;
        return json(constant);
    }
    /**
     * The magic link: `GET …?token=…&next=…`. Signs in whatever browser opened it
     * (the same-device happy path) and redirects to `next`. A spent, expired, or
     * unknown token lands on `next` without a cookie rather than announcing which.
     */
    async function verifyLink({ request }) {
        const url = new URL(request.url);
        const token = url.searchParams.get('token') ?? '';
        const next = safeNext(url.searchParams.get('next'), defaultNext);
        const nowS = sec(nowMs());
        const fail = () => new Response(null, { status: 302, headers: { location: next, 'cache-control': 'no-store' } });
        if (!token)
            return fail();
        const row = usable(await store.byTokenHash(await hashToken(token)), nowS);
        if (!row)
            return fail();
        const claimed = await store.consume(row.id, sec(nowMs()));
        if (!claimed)
            return fail();
        const signedIn = await gate.signIn(row.email, request);
        if (!signedIn) {
            return new Response(null, {
                status: 302,
                headers: { location: `${defaultNext}?denied=${encodeURIComponent(row.email)}`, 'cache-control': 'no-store' },
            });
        }
        const headers = new Headers({ location: next, 'cache-control': 'no-store' });
        headers.append('set-cookie', signedIn.cookie);
        return new Response(null, { status: 302, headers });
    }
    /**
     * The code path: `POST {id, code}`. Signs the session into *this* response —
     * the original tab — which is what makes it the cross-device rescue. Every
     * failure (unknown id, expired, wrong code, too many guesses) returns the same
     * `{ ok: false }`, so a caller learns only "that didn't work", never why.
     */
    async function verifyCode({ request }) {
        const body = (await request.json().catch(() => ({})));
        const id = typeof body.id === 'string' ? body.id : '';
        const code = typeof body.code === 'string' ? body.code.trim() : '';
        const nowS = sec(nowMs());
        const invalid = json({ ok: false }, 400);
        const row = usable(await store.byId(id), nowS);
        if (!row || row.attempts >= maxAttempts)
            return invalid;
        if ((await hashCode(row.email, code)) !== row.codeHash) {
            await store.bumpAttempts(id);
            return invalid;
        }
        const claimed = await store.consume(id, sec(nowMs()));
        if (!claimed)
            return invalid;
        const signedIn = await gate.signIn(row.email, request);
        if (!signedIn)
            return json({ ok: false }, 403);
        return json({ ok: true }, 200, { 'set-cookie': signedIn.cookie });
    }
    /**
     * `GET …?id=…` — the original tab watches for the link being clicked *in this
     * same browser* (the cookie is then already set, so the FE just re-probes
     * whoami). Returns only a coarse status; an unknown id reads as `expired`, so
     * polling can't confirm a row exists. It never mints a session: the code does
     * that in-place, and handing one out to anyone holding the (non-secret) `id`
     * would make the id a bearer credential.
     */
    async function poll({ request }) {
        const id = new URL(request.url).searchParams.get('id') ?? '';
        const nowS = sec(nowMs());
        const row = await store.byId(id);
        const status = !row || row.expiresAt <= nowS ? 'expired' : row.consumedAt !== null ? 'used' : 'pending';
        return json({ status });
    }
    return { start, verifyLink, verifyCode, poll };
}
