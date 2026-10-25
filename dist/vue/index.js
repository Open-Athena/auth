export { AuthGate } from './AuthGate.js';
export { reportUnauthenticated } from '../client/auth-events.js';
export { isSessionLossReason, sessionLossMessage } from '../core/denial.js';
export { useWhoami } from './useWhoami.js';
export { exchangeKeyParam, exchangeKeyParam as exchangeKey, hasKeyParam } from '../client/exchange.js';
export { DEFAULT_WHOAMI_ENDPOINT, displayName, hasScope } from '../client/identity.js';
