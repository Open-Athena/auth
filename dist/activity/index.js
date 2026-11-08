/**
 * Staff-facing backend only. Apply `migrations/activity/` separately.
 * `record` never sends network requests; explicitly await `deliver`/`flush`
 * (or pass their promises to waitUntil). A cron/queue may retry `flush`.
 *
 * Limits: no durable job scheduler, throttling, session resumption, admin
 * routes, or UI. Policies are captured at ingestion, not retroactive.
 * Dedupe lasts until retention deletes the receipt. Reusing an event ID
 * with changed content is still a duplicate (first accepted write wins).
 * Delivery leases fence database acknowledgements, not remote APIs: a
 * timeout/crash after a remote create, or a send outliving its lease, may
 * duplicate a message. A stale remote edit may need a later flush to repair.
 */
import { activityInteger, activityText, checkActivityEvent, checkActivityKind, checkActivityKinds } from './shape.js';
import { BATCH_GAP_S, DEFAULT_ACTIVITY_KINDS } from './types.js';
export * from './types.js';
export { activityActorFromAuth, sessionLogActivity, accessLogActivity } from './bridges.js';
export { activityRoutes } from './routes.js';
export function activityFeed(options) {
    const { store, gapS = BATCH_GAP_S, leaseS = 60, now = () => Math.floor(Date.now() / 1000) } = options;
    const defaults = { ...DEFAULT_ACTIVITY_KINDS, ...options.kinds };
    checkActivityKinds(defaults);
    activityInteger(gapS, 'gap', 1);
    activityInteger(leaseS, 'lease', 1);
    const sinks = [...(options.sinks ?? [])];
    const ids = new Set();
    for (const sink of sinks) {
        activityText(sink.id, 'sink id');
        if (sink.staffOnly !== true || ids.has(sink.id))
            throw new TypeError('activity: sinks must be distinct and staff-only');
        ids.add(sink.id);
    }
    async function kinds() {
        const saved = await store.readKinds();
        return Object.fromEntries(Object.entries(defaults).map(([kind, policy]) => [kind, saved[kind] ?? policy]));
    }
    async function deliverTo(burstId, sink) {
        const claim = await store.claim(burstId, sink.id, now(), leaseS);
        if (!claim)
            return { sink: sink.id, status: 'busy' };
        try {
            const burst = await store.get(burstId);
            if (!burst) {
                await store.release(burstId, sink.id, claim.token);
                return { sink: sink.id, status: 'missing' };
            }
            const messageId = await sink.send(burst, claim.messageId);
            const completed = await store.complete(burstId, sink.id, claim.token, messageId, burst.version);
            return { sink: sink.id, status: completed ? 'sent' : 'fenced' };
        }
        catch (error) {
            // Failed/ambiguous delivery remains pending. The caller owns reporting and retry policy.
            await store.release(burstId, sink.id, claim.token);
            throw error;
        }
    }
    return {
        kinds,
        async setKind(kind, policy) {
            if (!Object.hasOwn(defaults, kind))
                throw new TypeError('activity: undeclared kind');
            checkActivityKind(kind, policy);
            await store.writeKind(kind, policy);
        },
        async record(event) {
            checkActivityEvent(event);
            const configured = await kinds();
            const policy = Object.hasOwn(configured, event.kind) ? configured[event.kind] : undefined;
            if (!policy || policy.record === 'off')
                return { status: 'off', burstId: null };
            return store.append({ ...event, policy }, now(), gapS);
        },
        async deliver(burstId) {
            const results = [];
            for (const sink of sinks)
                results.push(await deliverTo(burstId, sink));
            return results;
        },
        /** At most `limit` burst attempts per sink; a failure rejects and leaves later work pending. */
        async flush(limit = 100) {
            activityInteger(limit, 'limit', 1);
            const results = [];
            for (const sink of sinks) {
                for (const id of await store.pending(sink.id, limit))
                    results.push(await deliverTo(id, sink));
            }
            return results;
        },
        /** Whole inactive bursts, by server receipt time. Call repeatedly while deletion counts are nonzero. */
        purge: (cutoffS, limit = 200) => store.purge(cutoffS, now(), limit),
    };
}
