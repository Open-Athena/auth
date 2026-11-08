import type { ActivityEvent, ActivityKind, ActivityKinds, ActivityWrite } from './types.js';
export declare function activityText(value: string, field: string, max?: number): void;
export declare function activityInteger(value: number, field: string, min?: number): void;
export declare function checkActivityKind(kind: string, policy: ActivityKind): void;
export declare function checkActivityKinds(kinds: ActivityKinds): void;
/** URL parsing rather than string concatenation prevents token-bearing queries reaching storage or sinks. */
export declare function activityPath(value: string): string;
export declare function checkActivityEvent(e: ActivityEvent): void;
export declare function checkActivityWrite(e: ActivityWrite): void;
