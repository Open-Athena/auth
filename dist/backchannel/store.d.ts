/** Session correlation and gate enforcement are deliberately outside this store. */
export interface LogoutBinding {
    issuer: string;
    clientId: string;
    sid: string;
}
export interface LogoutEvidence extends LogoutBinding {
    sub: string | null;
    jti: string;
    /** SHA-256 of the exact signed compact token, never the token itself. */
    digest: string;
    issuedAt: number;
    expiresAt: number;
}
export type LogoutAcceptance = 'accepted' | 'duplicate' | 'conflict';
export interface BackchannelStore {
    /** Trusted server API: call only with evidence from verifyLogoutToken. Atomic receipt + tombstone. */
    accept(evidence: LogoutEvidence, nowS: number, retainUntil: number): Promise<LogoutAcceptance>;
    /** Fail closed by SID even if a caller's subject differs; no email-based lookup. */
    isRevoked(binding: LogoutBinding, nowS: number): Promise<boolean>;
    /** Delete at most limit expired rows per table; logical expiry never depends on cleanup. */
    cleanup(nowS: number, limit?: number): Promise<number>;
}
export declare function checkBinding(binding: LogoutBinding, nowS: number): void;
export declare function checkAcceptance(evidence: LogoutEvidence, nowS: number, retainUntil: number): void;
export declare function checkCleanup(nowS: number, limit: number): void;
export declare function memoryBackchannelStore(): BackchannelStore;
