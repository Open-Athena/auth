import { isErrorEvent } from '../core/session-log-shape.js';
import { activityInteger, activityPath, activityText } from './shape.js';
/** Use only a trusted server identity. The private grant memo is deliberately not used as a recipient name. */
export function activityActorFromAuth(auth) {
    return auth.kind === 'sso'
        ? { id: `email:${auth.email}`, name: auth.subject?.name?.trim() || auth.email, via: 'sso' }
        : {
            id: `grant:${auth.grant.id}`,
            name: auth.grant.subject?.name?.trim() || auth.grant.email || 'Unnamed recipient',
            // A service link's activity is reported only when notable (`activityFeed`'s `service` option).
            via: auth.grant.service ? 'service' : 'grant',
        };
}
function sessionEvent(event, receivedMs) {
    const { k } = event;
    if (k === 'dropped')
        return null;
    if (isErrorEvent(event, receivedMs))
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
            const client = (await options.client?.(input)) ?? null;
            // Stable per-event keys allow safe retry after partially bridging a stored batch.
            for (const [index, event] of batch.events.entries()) {
                const mapped = (options.event ?? sessionEvent)(event, receipt * 1000);
                if (!mapped)
                    continue;
                await feed.record({
                    ...mapped,
                    id: `session:${JSON.stringify([new URL(req.url).origin, batch.sid, batch.pid, batch.seq, index])}`,
                    actor,
                    origin: new URL(req.url).origin,
                    ts: Math.min(receipt, Math.floor(event.t / 1000)),
                    sessionId: batch.sid,
                    ...(client ? { client } : {}),
                });
            }
        },
        async onPurge(cutoffS) { await feed.purge(cutoffS); },
    };
}
/**
 * An access row's client fingerprint: SHA-256 of its IP hash (already an HMAC, never an address) and user agent,
 * first 16 bytes. Null when the row has neither.
 */
async function accessClient(event) {
    if (!event.ipHash && !event.ua)
        return null;
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([event.ipHash ?? null, event.ua ?? null])));
    return [...new Uint8Array(digest).slice(0, 16)].map(b => b.toString(16).padStart(2, '0')).join('');
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
        const client = await accessClient(event);
        const denied = event.event === 'deny';
        const preview = event.event === 'preview';
        return feed.record({
            id: `access:${JSON.stringify([options.origin, id])}`,
            actor,
            origin: options.origin,
            ts: event.ts,
            kind: event.event === 'view' ? 'view' : denied ? 'denied' : preview ? 'preview' : 'access',
            line: denied || preview
                ? `${event.reason ?? (denied ? 'refused' : 'bot')}${path ? ` ${path}` : ''}`
                : `${event.event}${path ? ` ${path}` : ''}`,
            path,
            ...(client ? { client } : {}),
        });
    };
}
