/**
 * Staff-facing backend only. Apply `migrations/activity/` separately.
 * `record` never sends network requests; explicitly await `deliver`/`flush`
 * (or pass their promises to waitUntil). A cron/queue may retry `flush`.
 *
 * Limits: no durable job scheduler, throttling, admin
 * routes, or UI. Policies are captured at ingestion, not retroactive.
 * Dedupe lasts until retention deletes the receipt. Reusing an event ID
 * with changed content is still a duplicate (first accepted write wins).
 * Delivery leases fence database acknowledgements, not remote APIs. The Slack
 * sink saves a pending post first and tags every message, so a post that
 * landed before a timeout or crash is adopted on the next send (given a history
 * scope); a Discord create may still duplicate. A stale remote edit may need a
 * later flush to repair.
 */
import { activityInteger, activityText, checkActivityEvent, checkActivityGrouping, checkActivityKind, checkActivityKinds } from './shape.js';
import { ACTIVITY_RETRY_MAX_S, ACTIVITY_RETRY_S, BATCH_GAP_S, DEFAULT_ACTIVITY_KINDS, RESUME_S } from './types.js';
export * from './types.js';
export { activityActorFromAuth, sessionLogActivity, accessLogActivity } from './bridges.js';
export { activityRoutes } from './routes.js';
export { DISCORD_FMT, fmtGap, renderDetails, renderHeadline, renderKindLines, sessionTag, SLACK_FMT } from './render.js';
/** Marks a service burst that was judged routine: delivered, with nothing posted. */
const QUIET = '-';
/** Why a service burst is notable, by default: a run of errors, any refused request, or a client it hasn't used before. */
export function serviceReasons(burst, newClients, errorThreshold = 3) {
    const reasons = [];
    const errors = burst.counts.error ?? 0;
    if (errors >= errorThreshold)
        reasons.push(`${errors} errors`);
    const denied = burst.counts.denied ?? 0;
    if (denied) {
        const why = [...new Set(burst.lines.filter(l => l.kind === 'denied' && l.line).map(l => l.line))].slice(0, 3);
        reasons.push(`${denied} refused ${denied === 1 ? 'request' : 'requests'}${why.length ? ` (${why.join('; ')})` : ''}`);
    }
    if (newClients.length)
        reasons.push(newClients.length === 1 ? 'a new client' : `${newClients.length} new clients`);
    return reasons;
}
export function activityFeed(options) {
    const { store, gapS = BATCH_GAP_S, leaseS = 60, now = () => Math.floor(Date.now() / 1000) } = options;
    const defaults = { ...DEFAULT_ACTIVITY_KINDS, ...options.kinds };
    checkActivityKinds(defaults);
    const grouping = checkActivityGrouping({ gapS, resumeS: options.resumeS ?? RESUME_S, maxSpanS: options.maxSpanS ?? null, by: options.by ?? 'actor' });
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
            const posted = claim.messageId === QUIET ? null : claim.messageId;
            if (burst.actor.via === 'service') {
                const newClients = await store.newClients(burstId);
                const reasons = options.service?.notable
                    ? await options.service.notable(burst, { newClients })
                    : serviceReasons(burst, newClients, options.service?.errorThreshold);
                // A burst already posted green keeps its color as it grows; a clean one with no red before it posts nothing.
                const green = !reasons.length && (posted !== null || (await store.serviceRed(burst.actor.id, burst.origin, sink.id)));
                if (!reasons.length && !green) {
                    const completed = await store.complete(burstId, sink.id, claim.token, QUIET, burst.version);
                    return { sink: sink.id, status: completed ? 'quiet' : 'fenced' };
                }
                burst.notice = reasons.length ? { color: 'red', reasons } : { color: 'green', reasons: [] };
            }
            let state = structuredClone(claim.state);
            const ctx = {
                get state() { return state; },
                async put(next) {
                    state = structuredClone(next);
                    return store.checkpoint(burstId, sink.id, claim.token, state);
                },
                nowS: now,
            };
            const messageId = await sink.send(burst, posted, ctx);
            const completed = await store.complete(burstId, sink.id, claim.token, messageId, burst.version);
            if (completed && burst.notice)
                await store.setServiceRed(burst.actor.id, burst.origin, sink.id, burst.notice.color === 'red', now());
            return { sink: sink.id, status: completed ? 'sent' : 'fenced' };
        }
        catch (error) {
            // Failed/ambiguous delivery remains pending, but waits before the next attempt, so drains on
            // every request don't each call a sink that keeps refusing. The caller owns reporting.
            const waitS = Math.min(ACTIVITY_RETRY_S * 2 ** claim.failures, ACTIVITY_RETRY_MAX_S);
            await store.defer(burstId, sink.id, claim.token, now() + waitS);
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
            const resumePolicy = Object.hasOwn(configured, 'resume') ? configured.resume : undefined;
            return store.append({ ...event, policy, ...(resumePolicy ? { resumePolicy } : {}) }, now(), grouping);
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
