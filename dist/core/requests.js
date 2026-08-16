export const noopNotify = async () => { };
/**
 * Deliberately permissive: one `@`, no whitespace, a dot in the domain. Address
 * syntax is famously baroque, and the real validation is that approval mail has
 * to arrive — rejecting exotic-but-legal addresses here would only lock out
 * real people.
 */
export function isEmailish(email) {
    return /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(email);
}
export const DEFAULT_RATE_LIMIT = { perEmail: 3, perIp: 10, windowS: 3600 };
