/** Safe public explanations; never include credentials or principal details. */
export type SessionLossReason = 'revoked' | 'expired' | 'rotated' | 'delisted' | 'invalid';
export declare function isSessionLossReason(value: unknown): value is SessionLossReason;
export declare const sessionLossMessage: (reason: SessionLossReason) => string;
