/** Safe public explanations; never include credentials or principal details. */
export type SessionLossReason = 'revoked' | 'expired' | 'rotated' | 'delisted' | 'invalid'

const messages: Record<SessionLossReason, string> = {
  revoked: 'This link was revoked.',
  expired: 'This session or link expired.',
  rotated: 'This link was replaced; ask for the new one.',
  delisted: 'This account no longer has access.',
  invalid: 'This sign-in is no longer valid. Please sign in again.',
}

export function isSessionLossReason(value: unknown): value is SessionLossReason {
  return typeof value === 'string' && Object.hasOwn(messages, value)
}

export const sessionLossMessage = (reason: SessionLossReason): string => messages[reason]
