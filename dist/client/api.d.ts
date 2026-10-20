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
    whoami: () => Promise<import("./identity.js").Whoami>;
    logout: () => Promise<import("../core/http.js").OkResponse>;
    grants: {
        mint: (input: MintInput) => Promise<import("../core/http.js").MintResponse>;
        list: ({ active }?: GrantListInput) => Promise<import("../core/http.js").GrantsResponse>;
        update: (id: string, patch: GrantUpdateInput) => Promise<import("../core/http.js").GrantResponse>;
        revoke: (id: string) => Promise<import("../core/http.js").OkResponse>;
        disable: (id: string) => Promise<import("../core/http.js").OkResponse>;
        enable: (id: string) => Promise<import("../core/http.js").OkResponse>;
        rotate: (id: string, input?: RotateInput) => Promise<import("../core/http.js").RotateResponse>;
        activity: (id: string) => Promise<import("../core/store.js").GrantActivity>;
    };
    log: ({ grant, limit }?: LogInput) => Promise<import("../core/http.js").LogResponse>;
};
export type AuthClient = ReturnType<typeof createAuthClient>;
/** Construct locally: the token is never sent to a server by this helper. */
export declare function shareUrl(token: string, target?: string): string;
