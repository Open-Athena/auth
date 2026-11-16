/**
 * `?key=-` (under any accepted `keyParam`) on any URL: sign this browser out of its share-link session (never an
 * email sign-in), then land on the same URL without it. A real key is 32 base64url characters, so this can't be one.
 */
export const CLEAR_KEY = '-';
