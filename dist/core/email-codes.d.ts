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
    /** HMAC of the client IP the send came from, or null when no IP was present. */
    ipHash: string | null;
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
    /**
     * Cap sends within `windowS`, per address and per source IP. The per-IP cap
     * (default 10) is looser than per-email (default 3) so a shared NAT doesn't
     * lock out colleagues, while still blunting one IP fanning out across many
     * allowed addresses. The client IP is read from `CF-Connecting-IP` /
     * `X-Forwarded-For`; absent it (local, tests), only the per-email cap applies.
     */
    rateLimit?: {
        windowS?: number;
        maxPerEmail?: number;
        maxPerIp?: number;
    };
    /** Where a successful link lands. Only same-origin paths; default `/`. */
    defaultNext?: string;
    nowMs?: () => number;
}
export declare function emailCodeAuth(opts: EmailCodeOptions): {
    start: ({ request, waitUntil, }: {
        request: Request;
        waitUntil?: (p: Promise<unknown>) => void;
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
