export type AccessEventKind = 'mint' | 'redeem' | 'deny' | 'disable' | 'enable' | 'update' | 'revoke' | 'rotate' | 'request' | 'view' | 'signin' | 'signout';
export interface AccessEvent {
    ts: number;
    event: AccessEventKind;
    grantId?: string | null;
    sessionSub?: string | null;
    path?: string | null;
    status?: number | null;
    /** HMAC of the client IP — correlate sessions without retaining addresses. */
    ipHash?: string | null;
    ua?: string | null;
    country?: string | null;
    /** Where and on what network the client is, from Cloudflare's `request.cf`: enough to tell "the person I sent it to" from "someone else", without keeping an address. */
    city?: string | null;
    region?: string | null;
    /** The client's network operator (`cf.asOrganization`), e.g. "Comcast" or "Amazon.com". */
    asOrg?: string | null;
    referer?: string | null;
    /**
     * Event detail. On `deny`: `expired`, `revoked`, `disabled`, `exhausted`,
     * `bad-token`, `not-allowed`. On `mint`: the actor, when it isn't an email
     * (`policy`) and so can't be a `sessionSub`. On `update`: the comma-separated
     * field names that changed, so the ledger shows *what* was altered.
     */
    reason?: string | null;
}
export interface AuditSink {
    log(event: AccessEvent): Promise<void>;
}
/** Drops everything. The default when an app hasn't wired a store. */
export declare const nullAudit: AuditSink;
export interface RequestMeta {
    path: string;
    ipHash: string | null;
    ua: string | null;
    country: string | null;
    city: string | null;
    region: string | null;
    asOrg: string | null;
    referer: string | null;
}
/**
 * Pull the loggable request metadata. The address and country come from
 * headers, which CF populates (`CF-Connecting-IP`/`CF-IPCountry`) and other
 * runtimes can set. City, region and network come from `request.cf` and are
 * null off Cloudflare.
 */
export declare function requestMeta(req: Request, ipSecret: string): Promise<RequestMeta>;
