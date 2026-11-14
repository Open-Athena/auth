import { activityText } from './shape.js';
import { activityMessage } from './render.js';
/** Slack's error codes are short fixed strings (`not_in_channel`); anything else is left out of logs. */
function slackErrorCode(error) {
    return typeof error === 'string' && /^[a-z_]{1,64}$/.test(error) ? ` (${error})` : '';
}
/** One bot-owned message per burst, edited as it grows. No user impersonation or app-specific actions. */
export function slackActivitySink(options) {
    activityText(options.id, 'sink id');
    activityText(options.channel, 'Slack channel');
    activityText(options.token, 'Slack token');
    if (options.staffOnly !== true)
        throw new TypeError('activity: Slack destination must be staff-only');
    return {
        id: options.id,
        staffOnly: true,
        async send(burst, messageId) {
            const text = activityMessage(burst, 2800);
            const method = messageId ? 'chat.update' : 'chat.postMessage';
            const response = await (options.fetch ?? fetch)(`https://slack.com/api/${method}`, {
                method: 'POST',
                headers: { authorization: `Bearer ${options.token}`, 'content-type': 'application/json' },
                signal: AbortSignal.timeout(10_000),
                body: JSON.stringify({
                    channel: options.channel,
                    ...(messageId ? { ts: messageId } : {}),
                    text,
                    blocks: [{ type: 'section', text: { type: 'plain_text', text, emoji: false } }],
                    mrkdwn: false,
                    parse: 'none',
                    unfurl_links: false,
                    unfurl_media: false,
                }),
            });
            if (!response.ok)
                throw new Error(`activity: Slack HTTP ${response.status}`);
            const result = await response.json();
            if (result.ok !== true || typeof result.ts !== 'string' || !result.ts)
                throw new Error(`activity: Slack rejected message${slackErrorCode(result.error)}`);
            return result.ts;
        },
    };
}
