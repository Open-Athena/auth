import { type SessionLogStore } from '../session-log/store.js';
export interface D1SessionLogOptions {
    /** Rows one purge statement deletes (default 500). */
    purgeChunk?: number;
    /** Statements per table per `purge` call (default 20): a call deletes at most `purgeChunk × purgeChunks` rows a table. */
    purgeChunks?: number;
}
export declare function d1SessionLogStore(db: D1Database, opts?: D1SessionLogOptions): SessionLogStore;
