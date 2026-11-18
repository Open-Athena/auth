import { LeaseLostError, memoryStore, oneKeyStore, SlackApiError, SlackClient, syncSlots, upsert } from '@open-athena/thrds';
import { activityText } from './shape.js';
import { bound, checkTimeZone, lineKinds, renderDetails, renderHeadline, renderKindLines, SLACK_FMT } from './render.js';
/**
 * A Slack failure as the sink reports it. `SlackApiError` carries Slack's whole reply, so only its short error code
 * (`not_in_channel`, and only one that looks like one) or HTTP status is kept.
 */
export function wrapSlackError(e) {
    if (e instanceof LeaseLostError)
        return new Error('activity: delivery lease lost');
    if (!(e instanceof SlackApiError))
        return e;
    if (e.kind === 'timeout')
        return new Error('activity: Slack timeout');
    if (e.kind === 'transport')
        return new Error('activity: Slack request failed');
    if (e.status !== 200)
        return new Error(`activity: Slack HTTP ${e.status}`);
    return new Error(`activity: Slack rejected message${e.slackCode ? ` (${e.slackCode})` : ''}`);
}
/** Slack's limit is far higher; this keeps one message readable. */
const MAX_TEXT = 3500;
/**
 * One Slack thread per burst, edited as it grows: a parent line (who, counts, when), a details reply (pages,
 * sessions), and one reply per notify=`line` kind. Posts as the actor when `actorSender` resolves one.
 */
export function slackActivitySink(options) {
    activityText(options.id, 'sink id');
    activityText(options.channel, 'Slack channel');
    activityText(options.token, 'Slack token');
    if (options.staffOnly !== true)
        throw new TypeError('activity: Slack destination must be staff-only');
    const links = {
        ...(options.eventHref ? { eventHref: options.eventHref } : {}),
        ...(options.sessionHref ? { sessionHref: options.sessionHref } : {}),
        ...(options.burstHref ? { burstHref: options.burstHref } : {}),
        ...(options.timeZone ? { timeZone: options.timeZone } : {}),
    };
    checkTimeZone(options.timeZone);
    // No retries: the feed's `defer` backoff is the retry policy, and an in-call wait could outlive the delivery lease.
    const client = new SlackClient({
        token: options.token, channel: options.channel, parse: 'none', timeoutMs: 10_000, retries: 0,
        ...(options.fetch ? { fetch: options.fetch } : {}),
    });
    /** Thrds' sync, its failures reported in the sink's words. */
    const sync = async (run) => {
        try {
            return await run();
        }
        catch (e) {
            throw wrapSlackError(e);
        }
    };
    return {
        id: options.id,
        staffOnly: true,
        async send(burst, messageId, ctx) {
            const sender = await options.actorSender?.(burst.actor, burst) ?? null;
            const asActor = sender !== null;
            // The sender applies when a message is created; an edit keeps the one it was posted as, and isn't in the hash.
            const as = sender ? { username: sender.username.slice(0, 80), ...(sender.iconUrl ? { iconUrl: sender.iconUrl } : {}) } : {};
            const headline = options.renderBurst?.({ burst, asActor, links }).text ?? renderHeadline(burst, { fmt: SLACK_FMT, links, asActor });
            const parent = { text: bound(headline, MAX_TEXT), ...as };
            // The sink's id is in the key, so two sinks posting to one channel never adopt each other's messages.
            const key = `activity:${options.id}:${burst.id}`;
            if (!ctx) {
                // No saved progress (a direct caller): just the parent, posted or edited.
                const seed = messageId ? { [key]: { parent: { ts: messageId, hash: '' }, slots: {} } } : {};
                return (await sync(() => upsert(client, memoryStore(seed), key, parent))).ts;
            }
            const replies = [
                ['details', renderDetails(burst, { fmt: SLACK_FMT, links })],
                // `kind:` keeps an app's own kind named `details` from sharing that reply.
                ...lineKinds(burst).map(kind => [`kind:${kind}`, renderKindLines(burst, kind, { fmt: SLACK_FMT, links })]),
            ];
            const slots = replies.flatMap(([slot, reply]) => reply ? [{ slot, msg: { text: bound(reply, MAX_TEXT), ...as } }] : []);
            const store = oneKeyStore({ get: () => structuredClone(ctx.state), put: state => ctx.put(state) });
            // A reply whose text didn't change isn't touched, and a post interrupted before it was saved is found by its
            // metadata tag and adopted; where the token can't read history, it's posted again (`scan-or-post`). A kind that
            // ages out of the burst keeps its last reply (no `prune`), and a message deleted in Slack is posted again.
            const r = await sync(() => syncSlots(client, store, { key, parent, slots }, { recover: 'scan-or-post', now: () => ctx.nowS() * 1000 }));
            return r.ts;
        },
    };
}
