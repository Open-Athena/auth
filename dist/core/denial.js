const messages = {
    revoked: 'This link was revoked.',
    expired: 'This session or link expired.',
    rotated: 'This link was replaced; ask for the new one.',
    delisted: 'This account no longer has access.',
    invalid: 'This sign-in is no longer valid. Please sign in again.',
};
export function isSessionLossReason(value) {
    return typeof value === 'string' && Object.hasOwn(messages, value);
}
export const sessionLossMessage = (reason) => messages[reason];
