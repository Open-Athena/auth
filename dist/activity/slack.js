import { activityText } from './shape.js';
import { bound, lineKinds, renderDetails, renderHeadline, renderKindLines, SLACK_FMT } from './render.js';
/** Slack's error codes are short fixed strings (`not_in_channel`); anything else is left out of logs. */
function slackErrorCode(error) {
    return typeof error === 'string' && /^[a-z_]{1,64}$/.test(error) ? ` (${error})` : '';
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
    };
    async function call(method, body) {
        const response = await (options.fetch ?? fetch)(`https://slack.com/api/${method}`, {
            method: 'POST',
            headers: { authorization: `Bearer ${options.token}`, 'content-type': 'application/json' },
            signal: AbortSignal.timeout(10_000),
            body: JSON.stringify({ channel: options.channel, parse: 'none', unfurl_links: false, unfurl_media: false, ...body }),
        });
        if (!response.ok)
            throw new Error(`activity: Slack HTTP ${response.status}`);
        const result = await response.json();
        if (result.ok !== true || typeof result.ts !== 'string' || !result.ts)
            throw new Error(`activity: Slack rejected message${slackErrorCode(result.error)}`);
        return result.ts;
    }
    return {
        id: options.id,
        staffOnly: true,
        async send(burst, messageId, ctx) {
            const sender = await options.actorSender?.(burst.actor, burst) ?? null;
            const asActor = sender !== null;
            // `username`/`icon_url` apply when a message is created; an edit keeps the sender it was posted as.
            const as = sender ? { username: sender.username.slice(0, 80), ...(sender.iconUrl ? { icon_url: sender.iconUrl } : {}) } : {};
            const headline = options.renderBurst?.({ burst, asActor, links }).text ?? renderHeadline(burst, { fmt: SLACK_FMT, links, asActor });
            const text = bound(headline, MAX_TEXT);
            const parent = messageId ? (await call('chat.update', { ts: messageId, text }), messageId) : await call('chat.postMessage', { text, ...as });
            if (!ctx)
                return parent;
            const parts = { ...ctx.parts };
            if (!messageId)
                await ctx.save(parent, parts);
            const replies = [
                ['details', renderDetails(burst, { fmt: SLACK_FMT, links })],
                // `kind:` keeps an app's own kind named `details` from sharing that reply.
                ...lineKinds(burst).map(kind => [`kind:${kind}`, renderKindLines(burst, kind, { fmt: SLACK_FMT, links })]),
            ];
            for (const [slot, reply] of replies) {
                if (!reply)
                    continue;
                const body = bound(reply, MAX_TEXT);
                const existing = parts[slot];
                if (existing) {
                    await call('chat.update', { ts: existing, text: body });
                }
                else {
                    parts[slot] = await call('chat.postMessage', { thread_ts: parent, text: body, ...as });
                    await ctx.save(parent, parts);
                }
            }
            return parent;
        },
    };
}
