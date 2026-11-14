import type { ActivitySink } from './types.js';
export interface DiscordActivityOptions {
    id: string;
    staffOnly: true;
    webhook: string;
    fetch?: typeof fetch;
}
/** The webhook is a secret; errors never interpolate it or a provider response body. */
export declare function discordActivitySink(options: DiscordActivityOptions): ActivitySink;
