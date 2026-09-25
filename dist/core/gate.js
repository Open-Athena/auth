/**
 * The gate: sessions and grants as peers.
 *
 * An SSO sign-in and a share link both end at the same first-party session
 * cookie; the only difference is the `sub` it carries. Grant-backed sessions
 * re-join their grant row on *every* request, so revoking a link kills every
 * session it ever minted, instantly — that property is what makes the social
 * story (assume forwarding; make it visible and revocable) actually work.
 */
import { nullAudit, requestMeta } from './audit.js';
import { assetId, assetUri } from './assets.js';
import { InvalidImageError, MAX_INLINE_AVATAR_BYTES, bytesToDataUri, isGithubHandle, isSafeAvatarUrl, resolveAvatar, validateUploadedImage, } from './avatar.js';
import { looksAutomated } from './bots.js';
import { cleanName } from './profile.js';
import { adminPolicy, firstMatch } from './policy.js';
import { DEFAULT_RATE_LIMIT, isEmailish, noopNotify, subjectName, } from './requests.js';
import { DEFAULT_COOKIE_NAME, DEFAULT_SESSION_TTL_S, clearCookie, emailSub, grantSub, isSecureRequest, parseSub, readCookie, sessionCookie, signSession, verifySessionClaims, } from './session.js';
import { DEFAULT_DECISION_TTL_S, DEFAULT_REVERSAL_WINDOW_S, EMAIL_LINK_ACTOR, mayReverse, mintDecisionTokens, readDecisionToken, } from './decisions.js';
import { ALL_SCOPES } from './types.js';
import { generateId, generateToken, hashToken } from './tokens.js';
/** Why a grant was refused — checked in the order an admin would explain it. */
const denyReason = (grant) => grant.revokedAt ? 'revoked' : grant.disabledAt ? 'disabled' : 'expired';
const sec = (nowMs) => Math.floor(nowMs / 1000);
/**
 * Wrap a fetch so each call aborts after `ms`. Used only on the profile-seed
 * avatar fetch, which sits on the sign-in latency path against a third-party
 * host; `ms <= 0` disables it. Timing out surfaces as a rejection the seed
 * swallows into name-only, exactly the intended degradation.
 */
const withTimeout = (f, ms) => ms > 0 ? ((input, init) => f(input, { ...init, signal: AbortSignal.timeout(ms) })) : f;
/**
 * Two different questions, deliberately separated (see migration 0007).
 *
 * `canRedeem` — may this link mint a *new* session? Blocked by revoke, by
 * disable, and by expiry. (Redemption caps are checked in SQL, at redeem time,
 * so two concurrent opens can't both pass a `maxRedeems: 1` check.)
 *
 * `sessionValid` — may a session already minted from this link keep working?
 * Blocked by revoke always, and by expiry only when the link says so. Disabling
 * never touches it: "stop handing this out" is not "throw everyone out".
 */
export function canRedeem(grant, nowS) {
    return grant.revokedAt === null && grant.disabledAt === null && !isExpired(grant, nowS);
}
export function sessionValid(grant, nowS) {
    if (grant.revokedAt !== null)
        return false;
    return !(grant.expiryEndsSessions && isExpired(grant, nowS));
}
const isExpired = (grant, nowS) => grant.expiresAt !== null && grant.expiresAt <= nowS;
/**
 * @deprecated Ambiguous now that redemption and session validity can differ —
 * it answers the `canRedeem` question. Kept so an adopter's import doesn't
 * break mid-upgrade.
 */
export const isActive = canRedeem;
function grantAuth(grant) {
    return { kind: 'grant', grant, admin: false, scopes: grant.scopes };
}
export function createGate(opts) {
    const { store, secret, adminEmails = [], cookieName = DEFAULT_COOKIE_NAME, sessionTtlS = DEFAULT_SESSION_TTL_S, audit = nullAudit, touchIntervalS = 60, logViews = false, filterBots = true, profiles, assets, allowGrantSelfEdit = false, profileMinEditIntervalS = 0, profileUploadMaxBytes = 256 * 1024, seedAvatarTimeoutMs = 3000, fetch: fetchImpl = globalThis.fetch, } = opts;
    const policy = opts.policy
        ? firstMatch(adminPolicy(adminEmails), opts.policy)
        : adminPolicy(adminEmails);
    const isAdmin = (email) => adminEmails.some(a => a.toLowerCase() === email.toLowerCase());
    /**
     * The self-set identity to attach to an SSO principal, or null. Read on every
     * authenticate, same cadence as the grant re-join, so a name/face change is
     * live on the next request. Null when there's no profile store or no row —
     * `<Avatar>`/`displayName` fall back to initials exactly as before.
     */
    async function subjectFor(email) {
        if (!profiles)
            return null;
        const p = await profiles.get(email);
        if (!p)
            return null;
        const subject = {};
        if (p.name)
            subject.name = p.name;
        if (p.avatar)
            subject.avatar = p.avatar;
        return Object.keys(subject).length ? subject : null;
    }
    const notify = opts.notify ?? noopNotify;
    const log = (event) => audit.log(event);
    async function logWithRequest(req, event, nowS) {
        const meta = await requestMeta(req, secret);
        await log({ ts: nowS, ...meta, ...event });
    }
    function cookieFor(req, value, ttlS) {
        return sessionCookie(value, { name: cookieName, ttlS, secure: isSecureRequest(req) });
    }
    /**
     * Resolve the request's identity from (in order) a `?key=`/`Bearer` token or
     * the session cookie. The token forms let curl and scripts skip the cookie
     * exchange; they are request-scoped and never count as a redemption, since a
     * redemption means "a browser session was minted".
     */
    async function authenticate(req, nowMs = Date.now(), 
    /**
     * `logView: false` suppresses the automatic view row for this call. The
     * auth endpoints themselves use it: `/whoami` and `/track` are plumbing,
     * not pages, and logging them would bury the routes a visitor actually read
     * under one row per API call.
     */
    { logView: shouldLogView = true } = {}) {
        const nowS = sec(nowMs);
        const afterAuth = async (auth) => {
            if (logViews && shouldLogView)
                await logView(req, auth, nowS);
            return auth;
        };
        const url = new URL(req.url);
        const presented = req.headers.get('Authorization')?.match(/^Bearer (.+)$/)?.[1] ?? url.searchParams.get('key');
        if (presented) {
            const grant = await store.byTokenHash(await hashToken(presented));
            if (!grant) {
                await logWithRequest(req, { event: 'deny', reason: 'bad-token' }, nowS);
                return null;
            }
            // A presented token is the *link* being used, not a session being
            // resumed, so disabling blocks it: "stop letting new people in" has to
            // include the person still pasting the raw link into curl.
            if (!canRedeem(grant, nowS)) {
                await logWithRequest(req, { event: 'deny', grantId: grant.id, reason: denyReason(grant) }, nowS);
                return null;
            }
            await store.touch(grant.id, nowS, touchIntervalS);
            return await afterAuth(grantAuth(grant));
        }
        const cookie = readCookie(req, cookieName);
        if (!cookie)
            return null;
        const claims = await verifySessionClaims(cookie, secret, nowMs);
        if (!claims)
            return null;
        const sub = claims.sub;
        const parsed = parseSub(sub);
        if (!parsed)
            return null;
        if (parsed.kind === 'email') {
            const scopes = await policy(parsed.value);
            if (!scopes) {
                await logWithRequest(req, { event: 'deny', sessionSub: sub, reason: 'not-allowed' }, nowS);
                return null;
            }
            return await afterAuth({
                kind: 'sso',
                email: parsed.value,
                admin: isAdmin(parsed.value),
                scopes,
                subject: await subjectFor(parsed.value),
            });
        }
        // Re-join the grant every request: this is what makes revocation instant.
        // `sessionValid`, not `canRedeem` — a disabled link keeps its existing
        // sessions alive, and an expired one only ends them if it was minted to.
        const grant = await store.byId(parsed.value);
        // A rotation with `endSessions` stamps `sessionsInvalidBefore`; a session
        // whose `iat` predates it was minted from the old link and is booted — the
        // same "re-join every request" hook that makes revoke instant.
        const rotatedOut = grant !== null && grant.sessionsInvalidBefore !== null && claims.iat < grant.sessionsInvalidBefore;
        if (!grant || !sessionValid(grant, nowS) || rotatedOut) {
            await logWithRequest(req, {
                event: 'deny',
                grantId: parsed.value,
                sessionSub: sub,
                reason: !grant ? 'expired' : rotatedOut ? 'rotated' : denyReason(grant),
            }, nowS);
            return null;
        }
        await store.touch(grant.id, nowS, touchIntervalS);
        return await afterAuth(grantAuth(grant));
    }
    async function logView(req, auth, nowS = sec(Date.now()), path) {
        if (filterBots && looksAutomated(req))
            return;
        const meta = await requestMeta(req, secret);
        await log({
            ...meta,
            // A beacon reports the SPA route the visitor actually saw; without it the
            // log would only ever show `/api/track`, which answers nothing.
            ...(path ? { path } : {}),
            ts: nowS,
            ...(auth.kind === 'grant'
                ? { event: 'view', grantId: auth.grant.id, sessionSub: grantSub(auth.grant.id) }
                : { event: 'view', sessionSub: emailSub(auth.email) }),
        });
    }
    /** `?key=<token>` -> session cookie. This is the one path that spends a redemption. */
    async function redeem(token, req, nowMs = Date.now()) {
        const nowS = sec(nowMs);
        const existing = await store.byTokenHash(await hashToken(token));
        if (!existing) {
            await logWithRequest(req, { event: 'deny', reason: 'bad-token' }, nowS);
            return { ok: false, reason: 'bad-token' };
        }
        const grant = await store.redeem(existing.id, nowS);
        if (!grant) {
            // The SQL guard failed. Re-read the row we already have to say *why*,
            // rather than making the store report it: `exhausted` is the residual
            // case, i.e. the guard failed for a reason the row can't otherwise show.
            const reason = canRedeem(existing, nowS) ? 'exhausted' : denyReason(existing);
            await logWithRequest(req, { event: 'deny', grantId: existing.id, reason }, nowS);
            return { ok: false, reason };
        }
        const ttlS = grant.sessionTtlS ?? sessionTtlS;
        const cookie = cookieFor(req, await signSession(grantSub(grant.id), secret, nowMs, ttlS), ttlS);
        await logWithRequest(req, { event: 'redeem', grantId: grant.id, sessionSub: grantSub(grant.id) }, nowS);
        return { ok: true, grant, auth: grantAuth(grant), cookie };
    }
    /**
     * Would this address be admitted, and with what scopes? A pure policy check —
     * no mint, no cookie, no log — so a flow can decide whether to *offer* sign-in
     * (e.g. whether to mail an email-code) without the side effects of `signIn`.
     */
    async function admits(email) {
        return policy(email);
    }
    /** Mint a session for an identity an IdP just vouched for. Null if policy denies. */
    async function signIn(email, req, nowMs = Date.now()) {
        const nowS = sec(nowMs);
        const scopes = await policy(email);
        if (!scopes) {
            await logWithRequest(req, { event: 'deny', sessionSub: emailSub(email), reason: 'not-allowed' }, nowS);
            return null;
        }
        const cookie = cookieFor(req, await signSession(emailSub(email), secret, nowMs, sessionTtlS), sessionTtlS);
        await logWithRequest(req, { event: 'signin', sessionSub: emailSub(email) }, nowS);
        return { auth: { kind: 'sso', email, admin: isAdmin(email), scopes, subject: await subjectFor(email) }, cookie };
    }
    async function signOut(req, auth = null, nowMs = Date.now()) {
        await logWithRequest(req, { event: 'signout', sessionSub: auth?.kind === 'sso' ? emailSub(auth.email) : auth ? grantSub(auth.grant.id) : null }, sec(nowMs));
        return clearCookie({ name: cookieName, secure: isSecureRequest(req) });
    }
    /**
     * The `Set-Cookie` that drops this gate's session cookie, with no sign-out
     * event: for the deny path, where the browser is still sending a cookie
     * whose grant was revoked or expired, or whose email was delisted. Left
     * alone it would ride every request until its own `Max-Age` ran out —
     * failing correctly, but noisily, and on the cookie's schedule not ours.
     */
    function expireCookie(req) {
        return clearCookie({ name: cookieName, secure: isSecureRequest(req) });
    }
    async function mint(draft, nowMs = Date.now()) {
        const nowS = sec(nowMs);
        const token = generateToken();
        const grant = {
            id: generateId(),
            name: draft.name ?? null,
            note: draft.note ?? null,
            subject: draft.subject ?? null,
            email: draft.email ?? null,
            scopes: draft.scopes,
            maxRedeems: draft.maxRedeems ?? null,
            redeems: 0,
            expiresAt: draft.expiresAt ?? null,
            sessionTtlS: draft.sessionTtlS ?? null,
            createdAt: nowS,
            createdBy: draft.createdBy,
            disabledAt: null,
            revokedAt: null,
            expiryEndsSessions: draft.expiryEndsSessions ?? true,
            sessionsInvalidBefore: null,
            firstUsedAt: null,
            lastUsedAt: null,
        };
        await store.insert(grant, await hashToken(token));
        // Without this the timeline starts at `redeem`, so "who handed this link
        // out" is only recoverable from `grants.created_by` — not from the log an
        // admin would actually read, and not at all once the grant is deleted.
        // `createdBy` is free-form (an admin email, but `policy` for auto-grants),
        // so only email actors get a `sub`; the rest are identified by `grantId`.
        await log({
            ts: nowS,
            event: 'mint',
            grantId: grant.id,
            sessionSub: isEmailish(grant.createdBy) ? emailSub(grant.createdBy) : null,
            reason: isEmailish(grant.createdBy) ? null : grant.createdBy,
        });
        return { grant, token };
    }
    function requestStore() {
        if (!opts.requests)
            throw new Error('request-access is not configured: pass `requests` to createGate');
        return opts.requests;
    }
    /** Mint the grant an approval delivers, and hand it to `notify` with its token. */
    async function grantFor(request, scopes, createdBy, nowMs) {
        const { expiresInS = null, maxRedeems = null, sessionTtlS = null } = opts.approvalGrant ?? {};
        return mint({
            name: request.name ?? subjectName(request.subject) ?? request.email,
            // The whole point of collecting a name at request time: the minted
            // grant knows a person, so the watermark and chip say "Bob Smith".
            subject: request.subject,
            note: request.note,
            email: request.email,
            scopes,
            maxRedeems,
            expiresAt: expiresInS === null ? null : sec(nowMs) + expiresInS,
            sessionTtlS,
            createdBy,
        }, nowMs);
    }
    async function requestAccess(input, req, nowMs = Date.now()) {
        const requests = requestStore();
        const nowS = sec(nowMs);
        const email = input.email.trim().toLowerCase();
        if (!isEmailish(email))
            return { status: 'invalid' };
        const limits = { ...DEFAULT_RATE_LIMIT, ...opts.rateLimit };
        const meta = await requestMeta(req, secret);
        const since = nowS - limits.windowS;
        const [byEmail, byIp] = await Promise.all([
            requests.countSince(since, { email }),
            meta.ipHash ? requests.countSince(since, { ipHash: meta.ipHash }) : Promise.resolve(0),
        ]);
        if (byEmail >= limits.perEmail || byIp >= limits.perIp)
            return { status: 'rate-limited' };
        // A re-visit should show "pending", not queue a second row for an admin.
        const open = await requests.pendingByEmail(email);
        if (open)
            return { status: 'pending', request: open };
        const autoScopes = await policy(email);
        const request = {
            id: generateId(),
            email,
            name: input.name?.trim() || null,
            subject: input.subject ?? null,
            note: input.note?.trim() || null,
            createdAt: nowS,
            status: autoScopes ? 'auto' : 'pending',
            decidedAt: autoScopes ? nowS : null,
            decidedBy: autoScopes ? 'policy' : null,
            grantId: null,
        };
        if (autoScopes) {
            const { grant, token } = await grantFor(request, autoScopes, 'policy', nowMs);
            request.grantId = grant.id;
            await requests.insert(request, meta.ipHash);
            await log({ ts: nowS, ...meta, event: 'request', grantId: grant.id, sessionSub: emailSub(email) });
            await notify({ kind: 'access-granted', request, grant, token });
            return { status: 'auto', request, grant, token };
        }
        await requests.insert(request, meta.ipHash);
        await log({ ts: nowS, ...meta, event: 'request', sessionSub: emailSub(email) });
        const decision = opts.decisionLinks
            ? await mintDecisionTokens(request.id, opts.secret, nowMs, opts.decisionLinks.ttlS ?? DEFAULT_DECISION_TTL_S)
            : undefined;
        await notify({ kind: 'access-requested', request, decision });
        return { status: 'pending', request };
    }
    /** Approve a pending request: mint a grant bound to its email and deliver it. */
    async function approveRequest(id, approvedBy, override = {}, nowMs = Date.now()) {
        const requests = requestStore();
        const nowS = sec(nowMs);
        const existing = await requests.byId(id);
        if (!existing || existing.status !== 'pending')
            return null;
        const scopes = override.scopes ?? opts.approvalGrant?.scopes ?? [];
        const { grant, token } = await grantFor(existing, scopes, approvedBy, nowMs);
        const request = await requests.decide(id, { status: 'approved', decidedBy: approvedBy, grantId: grant.id, nowS });
        if (!request) {
            // Another admin decided it in between; don't leave the grant usable.
            await store.revoke(grant.id, nowS);
            return null;
        }
        await notify({ kind: 'access-granted', request, grant, token });
        return { request, grant, token };
    }
    async function denyRequest(id, deniedBy, nowMs = Date.now()) {
        const request = await requestStore().decide(id, {
            status: 'denied',
            decidedBy: deniedBy,
            grantId: null,
            nowS: sec(nowMs),
        });
        if (request)
            await notify({ kind: 'access-denied', request });
        return request;
    }
    /**
     * Resolve a decision link. The whole state machine, in one place.
     *
     * `commit` is the GET/POST split, and it is load-bearing rather than
     * stylistic: mail scanners fetch every URL in a message, so a read-only
     * `commit: false` pass is what stops Outlook Safe Links from approving
     * requests on an admin's behalf.
     *
     * Kept a plain function returning a plain view so a Slack action handler is a
     * thin caller rather than a second copy of these rules.
     */
    async function decide(token, o = {}) {
        const cfg = opts.decisionLinks;
        if (!cfg)
            return { kind: 'invalid' };
        const nowMs = o.nowMs ?? Date.now();
        const parsed = await readDecisionToken(token, opts.secret, nowMs);
        if (!parsed)
            return { kind: 'invalid' };
        const { verb, requestId } = parsed;
        const requests = requestStore();
        const request = await requests.byId(requestId);
        if (!request)
            return { kind: 'invalid' };
        if (!o.commit)
            return { kind: 'confirm', verb, request, token };
        if (cfg.requireAuth && !o.actor)
            return { kind: 'unauthorized', token };
        const actor = o.actor ?? EMAIL_LINK_ACTOR;
        const nowS = sec(nowMs);
        // Lost a race, or clicked a verb this mode won't honour. Either way the
        // answer is the same: show what happened, change nothing.
        const settled = async () => {
            const fresh = await requests.byId(requestId);
            return fresh ? { kind: 'already', verb, request: fresh } : { kind: 'invalid' };
        };
        if (request.status === 'pending') {
            if (verb === 'approve') {
                const done = await approveRequest(requestId, actor, {}, nowMs);
                return done ? { kind: 'decided', verb, request: done.request, reversed: false } : settled();
            }
            const done = await denyRequest(requestId, actor, nowMs);
            return done ? { kind: 'decided', verb, request: done, reversed: false } : settled();
        }
        if (!mayReverse(request, verb, cfg.reversal ?? 'first-wins', cfg.reversalWindowS ?? DEFAULT_REVERSAL_WINDOW_S, nowS))
            return { kind: 'already', verb, request };
        if (verb === 'approve') {
            // Mint before the compare-and-swap, revoke if the swap loses — the same
            // ordering `approveRequest` uses, for the same reason: a grant that
            // nothing points at must not stay usable.
            const scopes = opts.approvalGrant?.scopes ?? [];
            const { grant, token: fresh } = await grantFor(request, scopes, actor, nowMs);
            const updated = await requests.reverse(requestId, {
                from: request.status,
                status: 'approved',
                decidedBy: actor,
                grantId: grant.id,
                nowS,
            });
            if (!updated) {
                await store.revoke(grant.id, nowS);
                return settled();
            }
            await notify({ kind: 'access-granted', request: updated, grant, token: fresh });
            return { kind: 'decided', verb, request: updated, reversed: true };
        }
        const updated = await requests.reverse(requestId, {
            from: request.status,
            status: 'denied',
            decidedBy: actor,
            // Kept, not cleared: which grant was minted is the useful half of the
            // audit trail once it has been taken back.
            grantId: request.grantId,
            nowS,
        });
        if (!updated)
            return settled();
        // The reversal that matters. By now the approve has already mailed a working
        // link, so flipping a status column without revoking would leave the grant
        // live and the page claiming otherwise.
        if (request.grantId)
            await revoke(request.grantId, nowMs);
        await notify({ kind: 'access-denied', request: updated });
        return { kind: 'decided', verb, request: updated, reversed: true };
    }
    async function revoke(id, nowMs = Date.now()) {
        const nowS = sec(nowMs);
        const ok = await store.revoke(id, nowS);
        if (ok)
            await log({ ts: nowS, event: 'revoke', grantId: id });
        return ok;
    }
    /**
     * Re-key a share link. Mints a new token, swaps `token_hash` on the *same*
     * grant row — subject, scopes, expiry, and audit history all intact — and
     * returns the raw token once (like `mint`). The old `?key=` link stops
     * working on its next redemption.
     *
     * By default sessions already minted from the old link keep working — the
     * routine "shared too broadly, re-key it" case; `revoke` remains the terminal
     * option. Pass `endSessions: true` for the compromise case ("the link
     * leaked, boot whoever's inside"): it stamps a session epoch so every session
     * minted before now is rejected on its next request, without revoking the
     * grant — the freshly issued token still mints working sessions.
     *
     * Null if the grant does not exist or is revoked (revocation is terminal).
     */
    async function rotate(id, { endSessions = false } = {}, nowMs = Date.now()) {
        const nowS = sec(nowMs);
        const token = generateToken();
        const grant = await store.rotate(id, await hashToken(token), endSessions ? nowS : null);
        if (!grant)
            return null;
        await log({ ts: nowS, event: 'rotate', grantId: id, reason: endSessions ? 'end-sessions' : null });
        return { grant, token };
    }
    /**
     * Stop handing out new sessions, without touching the people already inside.
     * The softer half of `revoke`, and the reversible one — which is why it is
     * worth having: an admin who suspects a link has leaked can stop the bleeding
     * without logging out the person legitimately reading the page.
     */
    async function disable(id, nowMs = Date.now()) {
        const nowS = sec(nowMs);
        const ok = await store.setDisabled(id, nowS);
        if (ok)
            await log({ ts: nowS, event: 'disable', grantId: id });
        return ok;
    }
    /** Undo `disable`. Does not resurrect a revoked link — revocation is final. */
    async function enable(id, nowMs = Date.now()) {
        const nowS = sec(nowMs);
        const ok = await store.setDisabled(id, null);
        if (ok)
            await log({ ts: nowS, event: 'enable', grantId: id });
        return ok;
    }
    /**
     * Change a link's terms after minting. There is no reason expiry, redemption
     * cap or session TTL should be immutable — an admin extending a deadline
     * shouldn't have to mint a second link and re-send it.
     *
     * `sessionTtlS` is the exception worth knowing about: it is baked into the
     * cookie at redeem time, so changing it only affects future redemptions.
     */
    async function update(id, patch, nowMs = Date.now()) {
        const nowS = sec(nowMs);
        const grant = await store.update(id, patch);
        // Logged because changing a link's terms is exactly the sort of thing the
        // ledger exists to show: "who extended this, and when".
        if (grant)
            await log({ ts: nowS, event: 'update', grantId: id, reason: Object.keys(patch).sort().join(',') || null });
        return grant;
    }
    /** The email a profile is keyed by: an SSO principal, or an email-bound grant. */
    function principalEmail(auth) {
        return auth.kind === 'sso' ? auth.email : auth.grant.email;
    }
    /**
     * Who may edit their own profile. An SSO principal authenticated as
     * themselves, always. A grant session only when the app opted in *and* the
     * link is email-bound — an anonymous or forwarded link has no verified
     * principal, which is the "forwarding manufactures identities" hazard.
     */
    function mayEditProfile(auth) {
        if (auth.kind === 'sso')
            return true;
        return allowGrantSelfEdit && auth.grant.email !== null;
    }
    /** The caller's own profile, or null. Never reads another principal's row. */
    async function getProfile(auth) {
        if (!profiles)
            return null;
        const email = principalEmail(auth);
        return email ? profiles.get(email) : null;
    }
    /** Copy a supplied avatar server-side to a `data:` URI or `asset://` ref, or throw `InvalidImageError`. */
    async function resolveAvatarInput(input, email) {
        if ('upload' in input) {
            const cap = assets ? profileUploadMaxBytes : MAX_INLINE_AVATAR_BYTES;
            const { type, bytes } = validateUploadedImage(input.upload, { maxBytes: cap });
            if (assets)
                return { value: assetUri(await assets.put(bytes, type)), src: 'upload' };
            return { value: bytesToDataUri(type, bytes), src: 'upload' };
        }
        if ('url' in input) {
            if (!isSafeAvatarUrl(input.url))
                throw new InvalidImageError('avatar url must be https with no credentials');
            const data = await resolveAvatar({ url: input.url }, { inline: true, fetch: fetchImpl });
            if (!data)
                throw new InvalidImageError('could not fetch a valid image from that url');
            return { value: data, src: 'url' };
        }
        if ('github' in input) {
            if (!isGithubHandle(input.github))
                throw new InvalidImageError('not a valid github handle');
            const data = await resolveAvatar({ github: input.github }, { inline: true, fetch: fetchImpl });
            if (!data)
                throw new InvalidImageError('no github avatar for that handle');
            return { value: data, src: 'github' };
        }
        const data = await resolveAvatar({ email }, { inline: true, fetch: fetchImpl });
        if (!data)
            throw new InvalidImageError('no gravatar for your address');
        return { value: data, src: 'gravatar' };
    }
    /**
     * Set the caller's own display name and/or avatar. Only an authenticated self
     * may write, and only their own row. The avatar is always *copied* here — a
     * live third-party URL is never persisted, so rendering a profile never phones
     * a third party.
     */
    async function putProfile(auth, input, nowMs = Date.now()) {
        if (!profiles)
            return { ok: false, reason: 'unconfigured' };
        if (!mayEditProfile(auth))
            return { ok: false, reason: 'forbidden' };
        const email = principalEmail(auth);
        if (!email)
            return { ok: false, reason: 'forbidden' };
        const nowS = sec(nowMs);
        const existing = await profiles.get(email);
        if (existing && profileMinEditIntervalS > 0 && nowS - existing.updatedAt < profileMinEditIntervalS) {
            return { ok: false, reason: 'rate-limited' };
        }
        const name = 'name' in input ? cleanName(input.name) : (existing?.name ?? null);
        let avatar = existing?.avatar ?? null;
        let avatarSrc = existing?.avatarSrc ?? null;
        if (input.avatar !== undefined) {
            // Replacing or clearing: drop the prior asset so the store doesn't accrete
            // orphans. Inlined (`data:`) rows need no cleanup.
            const priorAsset = assetId(existing?.avatar);
            if (priorAsset && assets)
                await assets.del(priorAsset).catch(() => { });
            if (input.avatar === null) {
                avatar = null;
                avatarSrc = null;
            }
            else {
                try {
                    const resolved = await resolveAvatarInput(input.avatar, email);
                    avatar = resolved.value;
                    avatarSrc = resolved.src;
                }
                catch (e) {
                    const detail = e instanceof InvalidImageError ? e.message : 'invalid avatar';
                    return { ok: false, reason: 'invalid-avatar', detail };
                }
            }
        }
        const profile = { email, name, avatar, avatarSrc, updatedAt: nowS };
        await profiles.put(profile);
        return { ok: true, profile };
    }
    /**
     * Seed the profile for a just-signed-in SSO principal from the IdP's claims —
     * the name and face Google already verified, so the board isn't initials-only
     * until each member happens to open `ProfilePanel`. Best-effort and system-
     * sourced: it bypasses the self-edit rate limit, never overrides a self-set
     * profile, and a failed/slow picture fetch degrades to name-only rather than
     * breaking or stalling sign-in. No-op without a profile store. Returns the
     * resulting `Subject` (via `subjectFor`) so a caller could reissue if it
     * wanted — though it needn't: the subject is re-derived per request, so
     * awaiting this before responding already puts it on the first `/whoami`.
     *
     * See specs/done/oidc-profile-seed.md §1 for the "seed only when no row
     * exists" provenance rule and the optional refresh-on-login extension.
     */
    async function seedProfileFromClaims(email, claims, nowMs = Date.now()) {
        if (!profiles)
            return null;
        // A self-set profile (or an earlier seed) outranks the IdP: only the very
        // first sign-in for an email with no row seeds; every later one is a no-op.
        if (await profiles.get(email))
            return subjectFor(email);
        // The IdP's own display name, in the order and form the person uses; the
        // given/family pair only when that's all the IdP sent.
        const name = cleanName(claims.name ?? [claims.given_name, claims.family_name].filter(Boolean).join(' '));
        let avatar = null;
        if (claims.picture && isSafeAvatarUrl(claims.picture)) {
            try {
                // Inline the Google `picture` as a `data:` URI — never persist the live
                // `lh3.googleusercontent.com` URL, which would leak "this person opened
                // this page" to Google on every render. Bounded by a timeout: the host
                // is third-party and on the login path.
                avatar = await resolveAvatar({ url: claims.picture }, { inline: true, fetch: withTimeout(fetchImpl, seedAvatarTimeoutMs) });
            }
            catch {
                avatar = null;
            }
        }
        const profile = { email, name, avatar, avatarSrc: avatar ? 'url' : null, updatedAt: sec(nowMs) };
        await profiles.put(profile);
        return subjectFor(email);
    }
    /** The JSON an app hands its frontend. Never includes tokens or hashes. */
    function whoami(auth) {
        return auth.kind === 'sso'
            ? { kind: 'sso', email: auth.email, admin: auth.admin, scopes: auth.scopes, subject: auth.subject }
            : {
                kind: 'grant',
                // The grant id, so a recipient's UI can name the session it is in —
                // it is not a secret (the token is), and without it a link session
                // has no identifier a person can quote back to an admin.
                id: auth.grant.id,
                name: auth.grant.name,
                subject: auth.grant.subject,
                email: auth.grant.email,
                scopes: auth.scopes,
                admin: false,
                expiresAt: auth.grant.expiresAt,
            };
    }
    return {
        authenticate,
        redeem,
        signIn,
        admits,
        signOut,
        expireCookie,
        mint,
        revoke,
        rotate,
        disable,
        enable,
        update,
        logView,
        whoami,
        getProfile,
        putProfile,
        seedProfileFromClaims,
        isAdmin,
        cookieName,
        /**
         * The HMAC key, for adapters that need to sign something alongside a
         * session — the OIDC adapter's `state`, say. Not a widening of exposure:
         * anyone holding this object can already `signIn` as any address.
         */
        secret,
        requestAccess,
        approveRequest,
        denyRequest,
        decide,
        list: (o) => store.list(o),
        listRequests: (o) => requestStore().list(o),
    };
}
export { ALL_SCOPES };
