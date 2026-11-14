import type { ActivityBurst } from './types.js';
/** Both supplied sinks use bounded plain text; only notify=line events disclose detail. */
export declare function activityMessage(burst: ActivityBurst, max: number): string;
