import { activityText } from './shape.js';
import { checkTimeZone, renderDiscordMessage } from './render.js';
/** The webhook is a secret; errors never interpolate it or a provider response body. */
export function discordActivitySink(options) {
    activityText(options.id, 'sink id');
    const webhook = new URL(options.webhook);
    if (webhook.protocol !== 'https:' || webhook.hostname !== 'discord.com' || !/^\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+$/.test(webhook.pathname)
        || webhook.search || webhook.hash || webhook.username || webhook.password || webhook.port) {
        throw new TypeError('activity: invalid Discord webhook');
    }
    if (options.staffOnly !== true)
        throw new TypeError('activity: Discord destination must be staff-only');
    checkTimeZone(options.timeZone);
    return {
        id: options.id,
        staffOnly: true,
        async send(burst, messageId) {
            const url = new URL(webhook);
            if (messageId)
                url.pathname += `/messages/${encodeURIComponent(messageId)}`;
            else
                url.searchParams.set('wait', 'true');
            // Text is escaped by the renderer and cut to Discord's 2000 characters; mentions are suppressed below.
            const content = renderDiscordMessage(burst, options);
            const response = await (options.fetch ?? fetch)(url.href, {
                method: messageId ? 'PATCH' : 'POST',
                headers: { 'content-type': 'application/json' },
                signal: AbortSignal.timeout(10_000),
                body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
            });
            if (!response.ok) {
                // Discord's JSON error code (e.g. 10015 Unknown Webhook) says why; it never echoes the webhook.
                const code = (await response.json().catch(() => null))?.code;
                throw new Error(`activity: Discord HTTP ${response.status}${Number.isSafeInteger(code) ? ` (${code})` : ''}`);
            }
            const result = await response.json();
            if (typeof result.id !== 'string' || !result.id)
                throw new Error('activity: Discord returned no message ID');
            return result.id;
        },
    };
}
