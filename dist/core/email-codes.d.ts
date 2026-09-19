/**
 * Passwordless email sign-in for addresses that can't (or won't) use Google —
 * the non-Google tail that CF Access's OTP used to serve for free.
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
import type { Gate } from './gate.js';
import type { SendEmail } from './email.js';
import type { PendingAuthStore } from './store.js';
/** A row in `pending_auth`. Times are epoch seconds. */
export interface PendingAuth {
    id: string;
    email: string;
    tokenHash: string;
    codeHash: string;
    createdAt: number;
    expiresAt: number;
    consumedAt: number | null;
    attempts: number;
}
export interface EmailCodeOptions {
    gate: Gate;
    store: PendingAuthStore;
    /** Delivery. Reuse an adapter (`resendEmail`) or any `SendEmail`. */
    send: SendEmail;
    /** `Name <addr@domain>`; the domain must be one the provider has verified. */
    from: string;
    /** Builds the magic-link URL from the raw token. The app owns its URL space. */
    linkFor: (token: string) => string;
    /** Shown in the subject and body. Default `this site`. */
    appName?: string;
    /** How long a link/code is valid. Default 900s (15 min). */
    ttlS?: number;
    /** Wrong-code guesses allowed before the row is spent. Default 5. */
    maxAttempts?: number;
    /** Cap sends to one address within `windowS`. Default 3 per 900s. */
    rateLimit?: {
        windowS?: number;
        maxPerEmail?: number;
    };
    /** Where a successful link lands. Only same-origin paths; default `/`. */
    defaultNext?: string;
    nowMs?: () => number;
}
export declare function emailCodeAuth(opts: EmailCodeOptions): {
    start: ({ request }: {
        request: Request;
    }) => Promise<Response>;
    verifyLink: ({ request }: {
        request: Request;
    }) => Promise<Response>;
    verifyCode: ({ request }: {
        request: Request;
    }) => Promise<Response>;
    poll: ({ request }: {
        request: Request;
    }) => Promise<Response>;
};
