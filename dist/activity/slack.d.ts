import { type ActivityLinks } from './render.js';
import type { ActivityActor, ActivityBurst, ActivitySink } from './types.js';
/** Who a burst's posts are sent as. Needs the bot's `chat:write.customize` scope; without it Slack posts as the bot. */
export interface ActivitySender {
    username: string;
    /** An https image URL Slack can fetch. */
    iconUrl?: string;
}
export interface SlackActivityOptions extends ActivityLinks {
    id: string;
    staffOnly: true;
    token: string;
    channel: string;
    /**
     * Post as the actor: resolve their name and face from the app's own trusted data (a grant's subject, a
     * profile). Null, or no hook, posts as the bot with the actor named in the text.
     */
    actorSender?: (actor: ActivityActor, burst: ActivityBurst) => ActivitySender | null | Promise<ActivitySender | null>;
    /** Replace the parent message's text (mrkdwn; escape what you include). The thread replies are unchanged. */
    renderBurst?: (view: {
        burst: ActivityBurst;
        asActor: boolean;
        links: ActivityLinks;
    }) => {
        text: string;
    };
    fetch?: typeof fetch;
}
/**
 * A Slack failure as the sink reports it. `SlackApiError` carries Slack's whole reply, so only its short error code
 * (`not_in_channel`, and only one that looks like one) or HTTP status is kept.
 */
export declare function wrapSlackError(e: unknown): unknown;
/**
 * One Slack thread per burst, edited as it grows: a parent line (who, counts, when), a details reply (pages,
 * sessions), and one reply per notify=`line` kind. Posts as the actor when `actorSender` resolves one.
 */
export declare function slackActivitySink(options: SlackActivityOptions): ActivitySink;
