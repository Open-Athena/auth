import { signSession, verifySession } from './session.js';
export const DEFAULT_DECISION_TTL_S = 7 * 86400;
export const DEFAULT_REVERSAL_WINDOW_S = 3600;
/**
 * Recorded as `decidedBy` when the decision came from a link and nobody
 * authenticated. We do not have a name, so we do not print one — fabricated
 * attribution is worse than admitting there is none.
 */
export const EMAIL_LINK_ACTOR = 'email-link';
const sub = (verb, requestId) => `decide:${verb}:${requestId}`;
/**
 * Mints one token per verb.
 *
 * The verb is *inside* the signature, so holding the deny link does not let
 * anyone edit it into an approve — structural rather than checked. The request
 * id is in there too, so a token for one request is inert on another.
 */
export async function mintDecisionTokens(requestId, secret, nowMs, ttlS = DEFAULT_DECISION_TTL_S) {
    const [approve, deny] = await Promise.all([
        signSession(sub('approve', requestId), secret, nowMs, ttlS),
        signSession(sub('deny', requestId), secret, nowMs, ttlS),
    ]);
    return { approve, deny };
}
/** Null for anything forged, expired, malformed, or not a decision token. */
export async function readDecisionToken(token, secret, nowMs) {
    const claim = await verifySession(token, secret, nowMs);
    if (claim === null)
        return null;
    const parts = claim.split(':');
    if (parts.length !== 3 || parts[0] !== 'decide')
        return null;
    const [, verb, requestId] = parts;
    if (verb !== 'approve' && verb !== 'deny')
        return null;
    if (!requestId)
        return null;
    return { verb, requestId };
}
/**
 * Whether `verb` may overwrite a decision already recorded on `request`.
 *
 * Split out from the gate because it is the whole policy, and it is much easier
 * to be sure of when it is eight lines with no I/O in them.
 */
export function mayReverse(request, verb, mode, windowS, nowS) {
    if (request.status === 'pending')
        return true;
    if (mode === 'first-wins')
        return false;
    // A decision with no timestamp cannot be shown to be inside the window.
    if (request.decidedAt === null)
        return false;
    if (nowS - request.decidedAt > windowS)
        return false;
    if (mode === 'last-wins')
        return true;
    return verb === 'deny' && request.status === 'approved';
}
