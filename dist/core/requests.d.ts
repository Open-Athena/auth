/**
 * Request access ("enter your email") — the second affordance on the wall, next
 * to SSO. See specs/share-links-and-audit.md §2.
 *
 * There is no pre-verification round-trip: approval is *delivered by email*, so
 * someone who types a stranger's address merely causes mail to the real owner.
 * That is cheaper than a confirm-then-request dance and exactly as safe.
 */
import type { Grant, Subject } from './types.js';
export type RequestStatus = 'pending' | 'approved' | 'denied' | 'auto';
export interface AccessRequest {
    id: string;
    email: string;
    name: string | null;
    /**
     * Who they say they are, in the same shape a grant carries — so approval can
     * hand the minted grant a person rather than an address, and the watermark
     * and chip render "Bob Smith" instead of `bob@…`.
     */
    subject: Subject | null;
    note: string | null;
    createdAt: number;
    status: RequestStatus;
    decidedAt: number | null;
    decidedBy: string | null;
    /** The grant minted on approval — the thing actually delivered to them. */
    grantId: string | null;
}
/**
 * One pluggable hook for every outbound message, which answers both open
 * questions it was raised against: request-access notification transport and
 * magic-link delivery are the same problem, and neither belongs in the kernel.
 * Apps wire it to a Slack webhook, an email provider, or a `mailto:` prefill.
 */
export type Notify = (event: NotifyEvent) => Promise<void>;
export type NotifyEvent = 
/**
 * Someone is waiting on an admin. `decision` is present when the gate is
 * configured with `decisionLinks`, and carries one bearer token per verb so
 * the notification can be acted on without visiting the app.
 */
{
    kind: 'access-requested';
    request: AccessRequest;
    decision?: {
        approve: string;
        deny: string;
    };
}
/** A grant exists for them; `token` appears here and nowhere else, ever again. */
 | {
    kind: 'access-granted';
    request: AccessRequest;
    grant: Grant;
    token: string;
} | {
    kind: 'access-denied';
    request: AccessRequest;
};
export declare const noopNotify: Notify;
/**
 * Deliberately permissive: one `@`, no whitespace, a dot in the domain. Address
 * syntax is famously baroque, and the real validation is that approval mail has
 * to arrive — rejecting exotic-but-legal addresses here would only lock out
 * real people.
 */
export declare function isEmailish(email: string): boolean;
/**
 * Fields a stranger may fill in, clamped before they reach an admin's screen.
 *
 * Everything here is attacker-controlled text that gets rendered in a table
 * someone with `admin` is looking at, so it is length-capped and stripped of
 * control characters. `avatar` is *not* accepted from the form at all — a
 * URL supplied by an unauthenticated submitter and then rendered as `<img src>`
 * is a tracking pixel aimed at the admin page at best, so avatars are derived
 * client-side (`<Avatar>`) rather than collected. An app that genuinely wants
 * uploaded avatars can set `subject.avatar` itself after approval.
 */
export declare const MAX_SUBJECT_FIELD = 80;
export declare function cleanSubject(input: {
    name?: string | null;
}): Subject | null;
/** "Bob Smith" from a subject, or null if it holds no name. */
export declare function subjectName(subject: Subject | null | undefined): string | null;
export interface RateLimit {
    /** Max requests per email within `windowS`. Default 3. */
    perEmail?: number;
    /** Max requests per client IP within `windowS`. Default 10. */
    perIp?: number;
    /** Default 1 hour. */
    windowS?: number;
}
export declare const DEFAULT_RATE_LIMIT: Required<RateLimit>;
