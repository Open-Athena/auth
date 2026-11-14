import type { ActivitySink } from './types.js';
export interface SlackActivityOptions {
    id: string;
    staffOnly: true;
    token: string;
    channel: string;
    fetch?: typeof fetch;
}
/** One bot-owned message per burst, edited as it grows. No user impersonation or app-specific actions. */
export declare function slackActivitySink(options: SlackActivityOptions): ActivitySink;
