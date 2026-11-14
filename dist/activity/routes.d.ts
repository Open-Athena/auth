import type { ActivityFeed } from './index.js';
import type { ActivityStore } from './types.js';
export interface ActivityRoutesOptions {
    feed: ActivityFeed;
    store: Pick<ActivityStore, 'list' | 'get'>;
    basePath?: string;
    /** Mandatory application authorization; refusing must return 401 or 403. */
    requireAdmin: (request: Request) => Promise<{
        who: string;
    } | Response>;
}
/** Staff reads/settings only. There is intentionally no public event-ingestion route. */
export declare function activityRoutes({ feed, store, requireAdmin, basePath }: ActivityRoutesOptions): (request: Request) => Promise<Response | null>;
