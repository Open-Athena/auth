import { isSessionLossReason } from '../core/denial.js';
import { DEFAULT_WHOAMI_ENDPOINT } from './identity.js';
const listeners = new Set();
/** Report a failed request, not a logout command: subscribers revalidate. */
export function reportUnauthenticated(reason, source = {}) {
    const event = { reason: isSessionLossReason(reason) ? reason : null, endpoint: source.endpoint ?? DEFAULT_WHOAMI_ENDPOINT };
    for (const listener of listeners)
        listener(event);
}
export function subscribeUnauthenticated(listener) {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}
