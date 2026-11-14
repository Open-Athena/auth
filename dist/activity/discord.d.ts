import { type ActivityLinks } from './render.js';
import type { ActivitySink } from './types.js';
/** One message per burst (Discord webhooks have no threads to edit into), with the same links as Slack's. */
export interface DiscordActivityOptions extends ActivityLinks {
    id: string;
    staffOnly: true;
    webhook: string;
    fetch?: typeof fetch;
}
/** The webhook is a secret; errors never interpolate it or a provider response body. */
export declare function discordActivitySink(options: DiscordActivityOptions): ActivitySink;
