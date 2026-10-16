import { b64uDecodeString, b64uEncode } from './base64.js';
export const SELECTION_CONTEXT_HEADER = 'X-OA-Selection-Context';
export const MAX_SELECTION_CONTEXT_LENGTH = 2048;
const MAX_ID_LENGTH = 256;
function validId(value) {
    return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH;
}
function validContext(value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        return false;
    const context = value;
    return validId(context.browserSetId)
        && (context.sessionId === null || validId(context.sessionId))
        && typeof context.version === 'number'
        && Number.isSafeInteger(context.version) && context.version >= 0
        && !Object.is(context.version, -0);
}
/** Canonical unpadded base64url JSON; opaque to clients, not encrypted or signed. */
export function serializeSelectionContext(context) {
    if (!validContext(context))
        throw new TypeError('Invalid selection context');
    const { browserSetId, sessionId, version } = context;
    const header = b64uEncode(new TextEncoder().encode(JSON.stringify({ browserSetId, sessionId, version })));
    if (header.length > MAX_SELECTION_CONTEXT_LENGTH)
        throw new RangeError('Selection context is too large');
    return header;
}
/** Missing, oversized, noncanonical, or malformed assertions are invalid. */
export function parseSelectionContext(header) {
    if (!header || header.length > MAX_SELECTION_CONTEXT_LENGTH || !/^[A-Za-z0-9_-]+$/.test(header))
        return null;
    // Invalid client input is expected; invalid trusted server contexts throw instead.
    try {
        const context = JSON.parse(b64uDecodeString(header));
        if (!validContext(context) || serializeSelectionContext(context) !== header)
            return null;
        return context;
    }
    catch {
        return null;
    }
}
/**
 * Persist this increment atomically with every selection change (including
 * sign-out and A -> B -> A). Never reset/reuse a version within a browser set.
 * At exhaustion, fail closed or establish a new, unique browser-set ID.
 */
export function nextSelectionVersion(version) {
    if (!Number.isSafeInteger(version) || version < 0 || Object.is(version, -0)) {
        throw new TypeError('Invalid selection version');
    }
    if (version === Number.MAX_SAFE_INTEGER)
        throw new RangeError('Selection version exhausted');
    return version + 1;
}
/**
 * Run after authentication/authorization, before mutation side effects. `current`
 * must come from the caller's validated selection for this gate and browser set;
 * browser-set IDs must not be reused across gates. Retain that authenticated
 * actor for the request, and coordinate concurrent switches/mutations in the
 * caller's transaction when necessary. This comparison is not a store/CAS lock.
 *
 * The header is only a concurrency assertion, NOT authentication or CSRF
 * protection. A match even for sessionId:null confers no authority. On conflict,
 * refresh selection and ask the user to review; never automatically replay a
 * mutation under the new identity. No client field supplies an actor.
 */
export function checkSelectionContext(intendedHeader, current) {
    const actual = serializeSelectionContext(current);
    const intended = parseSelectionContext(intendedHeader);
    if (intended !== null && intendedHeader === actual)
        return null;
    return new Response(JSON.stringify({
        error: 'selection_context_conflict',
        recoverable: true,
        action: 'refresh_selection',
    }) + '\n', {
        status: 409,
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    });
}
