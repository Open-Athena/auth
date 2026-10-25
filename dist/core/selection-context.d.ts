export declare const SELECTION_CONTEXT_HEADER = "X-OA-Selection-Context";
export declare const MAX_SELECTION_CONTEXT_LENGTH = 2048;
/** Safe selectors, never credentials, subjects, emails, roles, or authority. */
export interface SelectionContext {
    browserSetId: string;
    sessionId: string | null;
    version: number;
}
/** Canonical unpadded base64url JSON; opaque to clients, not encrypted or signed. */
export declare function serializeSelectionContext(context: SelectionContext): string;
/** Missing, oversized, noncanonical, or malformed assertions are invalid. */
export declare function parseSelectionContext(header: string | null): SelectionContext | null;
/**
 * Persist this increment atomically with every selection change (including
 * sign-out and A -> B -> A). Never reset/reuse a version within a browser set.
 * At exhaustion, fail closed or establish a new, unique browser-set ID.
 */
export declare function nextSelectionVersion(version: number): number;
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
export declare function checkSelectionContext(intendedHeader: string | null, current: SelectionContext): Response | null;
