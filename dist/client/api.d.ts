import type { GrantListInput, GrantUpdateInput, LogInput, MintInput, RotateInput } from '../core/http.js';
export interface AuthClientOptions {
    basePath?: string;
    fetch?: typeof globalThis.fetch;
}
export declare class AuthClientError extends Error {
    readonly status: number;
    readonly body: unknown;
    constructor(status: number, body: unknown);
}
export declare function createAuthClient({ basePath, fetch }?: AuthClientOptions): {
    /** Where these routes are mounted, without a trailing slash. */
    basePath: string;
    whoami: () => Promise<import("./identity.js").Whoami>;
    /**
     * In retained-login mode, signs out of one account: the selection passed
     * here, for a page whose identity came from elsewhere (`useWhoami`), else the
     * one this client last saw. A stale one is refused with 409.
     */
    logout: (input?: {
        selection?: string | null;
    }) => Promise<import("../core/http.js").OkResponse>;
    grants: {
        mint: (input: MintInput) => Promise<import("../core/http.js").MintResponse>;
        list: ({ active }?: GrantListInput) => Promise<import("../core/http.js").GrantsResponse>;
        update: (id: string, patch: GrantUpdateInput) => Promise<import("../core/http.js").UpdateResponse>;
        revoke: (id: string) => Promise<import("../core/http.js").OkResponse>;
        disable: (id: string) => Promise<import("../core/http.js").OkResponse>;
        enable: (id: string) => Promise<import("../core/http.js").OkResponse>;
        rotate: (id: string, input?: RotateInput) => Promise<import("../core/http.js").RotateResponse>;
        activity: (id: string) => Promise<import("../core/store.js").GrantActivity>;
        /** A kept link's key (404 when none is kept). Logged server-side. */
        token: (id: string) => Promise<import("../core/http.js").TokenResponse>;
        /** Keep this link's current key (a pasted key or link), without rotating it. */
        keepToken: (id: string, token: string) => Promise<import("../core/http.js").OkResponse>;
        forgetToken: (id: string) => Promise<import("../core/http.js").OkResponse>;
    };
    log: ({ grant, limit }?: LogInput) => Promise<import("../core/http.js").LogResponse>;
};
export type AuthClient = ReturnType<typeof createAuthClient>;
/** Construct locally: the token is never sent to a server by this helper. */
/** Just the query a share link adds (`?key=…`), for pasting onto a URL of your own. */
export declare function shareKey(token: string): string;
export declare function shareUrl(token: string, target?: string): string;
