/**
 * Deciding an access request from the notification itself.
 *
 * The admin's half of the review flow. Without this, unblocking someone means
 * opening the app, authenticating, and finding the queue — three steps that
 * turn "someone is blocked" into "someone is blocked until tomorrow".
 *
 * The design constraint that shapes everything here is not the obvious one.
 * Bearer-authenticated links are fine: the notification goes to a group the
 * operator controls, and any member should be able to act. The dangerous part
 * is that **mail scanners fetch every URL in an incoming message** — Outlook
 * Safe Links, corporate gateways, antivirus. A `GET` that commits the decision
 * gets auto-clicked before a human reads the mail, and it looks like the admin
 * did it. So `GET` renders a confirmation page and `POST` commits, which is the
 * HTTP contract anyway.
 */
import type { AccessRequest } from './requests.js';
export type DecisionVerb = 'approve' | 'deny';
/** How a second, opposite decision is treated. See `reversalWindowS`. */
export type ReversalMode = 
/**
 * Default. The first decision is final, and `reversalWindowS` is unused —
 * one rule, no clock.
 *
 * A misclick is not unrecoverable under this mode, it is just fixed
 * somewhere else: an accidental approve is undone by revoking the grant in
 * the admin UI, an accidental deny by approving the re-request. That is a
 * better trade than a second, time-dependent rule that only applies to
 * whoever clicks twice within the hour.
 */
'first-wins'
/**
 * A deny within the window overrides an earlier approve; an approve never
 * overrides a deny.
 */
 | 'deny-wins'
/** Either verb overrides the other, within the window. */
 | 'last-wins';
export interface DecisionLinkOptions {
    /** How long a link in a mail stays usable. Default 7 days. */
    ttlS?: number;
    reversal?: ReversalMode;
    /**
     * How long after a decision the opposite verb may still reverse it. Default
     * 1 hour. Ignored under `first-wins`, which is the default mode.
     */
    reversalWindowS?: number;
    /**
     * Require an authenticated admin, rather than accepting whoever holds the
     * link. Default false.
     */
    requireAuth?: boolean;
    appName?: string;
}
export declare const DEFAULT_DECISION_TTL_S: number;
export declare const DEFAULT_REVERSAL_WINDOW_S = 3600;
/**
 * Recorded as `decidedBy` when the decision came from a link and nobody
 * authenticated. We do not have a name, so we do not print one — fabricated
 * attribution is worse than admitting there is none.
 */
export declare const EMAIL_LINK_ACTOR = "email-link";
/**
 * Mints one token per verb.
 *
 * The verb is *inside* the signature, so holding the deny link does not let
 * anyone edit it into an approve — structural rather than checked. The request
 * id is in there too, so a token for one request is inert on another.
 */
export declare function mintDecisionTokens(requestId: string, secret: string, nowMs: number, ttlS?: number): Promise<{
    approve: string;
    deny: string;
}>;
/** Null for anything forged, expired, malformed, or not a decision token. */
export declare function readDecisionToken(token: string, secret: string, nowMs: number): Promise<{
    verb: DecisionVerb;
    requestId: string;
} | null>;
/**
 * What the endpoint should show.
 *
 * A discriminated union rather than a rendered string, so an app can restyle
 * the page without re-deriving which of these four situations it is in.
 */
export type DecisionView = 
/** A valid link, not yet acted on. Render two buttons; commit nothing. */
{
    kind: 'confirm';
    verb: DecisionVerb;
    request: AccessRequest;
    token: string;
}
/** This click just decided it. */
 | {
    kind: 'decided';
    verb: DecisionVerb;
    request: AccessRequest;
    reversed: boolean;
}
/** Already settled; this click changed nothing. */
 | {
    kind: 'already';
    verb: DecisionVerb;
    request: AccessRequest;
}
/**
 * Forged, expired, malformed, or naming a request that no longer exists —
 * deliberately one case. Telling a prober *which* of those they achieved
 * tells them how close they got.
 */
 | {
    kind: 'invalid';
}
/** `requireAuth` is on and the caller has no admin session. */
 | {
    kind: 'unauthorized';
    token: string;
};
/**
 * Whether `verb` may overwrite a decision already recorded on `request`.
 *
 * Split out from the gate because it is the whole policy, and it is much easier
 * to be sure of when it is eight lines with no I/O in them.
 */
export declare function mayReverse(request: AccessRequest, verb: DecisionVerb, mode: ReversalMode, windowS: number, nowS: number): boolean;
