export type AccessEventKind = 'redeem' | 'deny' | 'revoke' | 'request' | 'view' | 'signin' | 'signout';
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
    referer?: string | null;
    /** Why a `deny` happened: `expired`, `revoked`, `exhausted`, `bad-token`, `not-allowed`. */
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
    referer: string | null;
}
/**
 * Pull the loggable request metadata. Header-based (not `request.cf`) so this
 * stays runtime-agnostic; CF populates `CF-Connecting-IP`/`CF-IPCountry` for free.
 */
export declare function requestMeta(req: Request, ipSecret: string): Promise<RequestMeta>;
