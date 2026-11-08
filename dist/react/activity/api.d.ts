import type { ActivityBurst, ActivityKind } from '../../activity/types.js';
export interface ActivityPage {
    bursts: ActivityBurst[];
}
export interface ActivityKindsPage {
    kinds: Record<string, ActivityKind>;
}
export declare const activityEndpoint: (endpoint: string) => string;
export declare function activityJson<T>(url: string, init?: RequestInit): Promise<T>;
export declare const activityKeys: (endpoint: string) => readonly ["oa-activity", string];
