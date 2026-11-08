import { isErrorEvent } from '../core/session-log-shape.js';
import { activityInteger, activityPath, activityText } from './shape.js';
/** Use only a trusted server identity. The private grant memo is deliberately not used as a recipient name. */
export function activityActorFromAuth(auth) {
    return auth.kind === 'sso'
        ? { id: `email:${auth.email}`, name: auth.subject?.name?.trim() || auth.email, via: 'sso' }
        : { id: `grant:${auth.grant.id}`, name: auth.grant.subject?.name?.trim() || auth.grant.email || 'Unnamed recipient', via: 'grant' };
}
function sessionEvent(event) {
    const { k } = event;
    if (k === 'dropped')
        return null;
    if (isErrorEvent(event))
        return { kind: 'error', line: String(event.msg ?? `${k} ${event.s ?? ''}`).slice(0, 2000) };
    if (k === 'start' || k === 'nav') {
        const path = typeof event.u === 'string' ? activityPath(event.u) : undefined;
        return { kind: k === 'start' ? 'view' : 'nav', line: path, path };
    }
    if (k === 'click')
        return { kind: 'click', line: String(event.l ?? event.n ?? 'click').slice(0, 2000) };
    return null;
}
/** Structurally compatible with sessionLogRoutes' onStored/onPurge; session retention remains independent. */
export function sessionLogActivity(feed, options) {
    const now = options.now ?? (() => Math.floor(Date.now() / 1000));
    return {
        async onStored(input) {
            const actor = await options.actor(input);
            if (!actor)
                return;
            const { batch, req } = input;
            const receipt = now();
            // Stable per-event keys allow safe retry after partially bridging a stored batch.
            for (const [index, event] of batch.events.entries()) {
                const mapped = (options.event ?? sessionEvent)(event);
                if (!mapped)
                    continue;
                await feed.record({
                    ...mapped,
                    id: `session:${JSON.stringify([new URL(req.url).origin, batch.sid, batch.pid, batch.seq, index])}`,
                    actor,
                    origin: new URL(req.url).origin,
                    ts: Math.min(receipt, Math.floor(event.t / 1000)),
                    sessionId: batch.sid,
                });
            }
        },
        async onPurge(cutoffS) { await feed.purge(cutoffS); },
    };
}
/**
 * Replay an accepted access-log row with its stable database ID (namespace it
 * when combining stores). Not an AuditSink wrapper: that interface has no row
 * ID or insert outcome, so it cannot safely mirror the access store's dedupe.
 * Browser and access views are independent observations; choose which to feed
 * for overlapping routes. No attempt is made to guess cross-source equality.
 */
export function accessLogActivity(feed, options) {
    return async (id, event) => {
        activityText(id, 'access row id', 256);
        activityInteger(event.ts, 'access timestamp');
        const actor = await options.actor(event);
        if (!actor)
            return null;
        const path = event.path ? activityPath(event.path) : undefined;
        return feed.record({
            id: `access:${JSON.stringify([options.origin, id])}`,
            actor,
            origin: options.origin,
            ts: event.ts,
            kind: event.event === 'view' ? 'view' : 'access',
            line: `${event.event}${path ? ` ${path}` : ''}`,
            path,
        });
    };
}
