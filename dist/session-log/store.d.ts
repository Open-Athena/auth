import type { Cursor, SessionDetail, SessionPage, SlogBatch } from '../core/session-log-shape.js';
/** Who sent a batch: always the request's own identity, never anything the client said. */
export interface SessionLogWho {
    /** A verified address, or null (an anonymous public viewer, or a link with no bound address). */
    email: string | null;
    /** How they got in: `'sso'`, `'grant'`, `'public'`, … (shown in the viewer). */
    via: string;
}
export type IngestResult = 'stored' | 'duplicate' | 'capped';
/** The switch's row: `until_ms` null = off. `who` and `ts` (epoch s) are the last change's. */
export interface SwitchRow {
    until_ms: number | null;
    who: string;
    ts: number;
}
export interface SessionFilter {
    /** Substring of the address, case-insensitive. */
    email?: string;
    /** Epoch ms: sessions active since then. */
    since?: number;
    errors?: boolean;
    /** Rows per page (default `SESSIONS_PAGE`, at most `SESSIONS_MAX_LIMIT`). */
    limit?: number;
    /** The page after this row (the "next" link), or */
    after?: Cursor;
    /** the page before it ("prev"). Neither = the first page. */
    before?: Cursor;
}
/** Thrown by a store whose tables don't exist (the migration isn't applied). */
export declare class SessionLogNotSetUp extends Error {
    constructor();
}
/** Where the session log lives. `d1SessionLogStore` (`/session-log/d1`) is the shipped one. */
export interface SessionLogStore {
    /**
     * Store one batch. A repeat of `(sid, pid, seq)` (a retried beacon) is
     * `'duplicate'` and counts nothing; a session already holding
     * `LIMITS.sessionEvents` stores nothing more (`'capped'`).
     */
    ingest(who: SessionLogWho, ua: string | null, batch: SlogBatch, nowS: number): Promise<IngestResult>;
    /**
     * Delete what was received before `cutoffS`, in bounded chunks, so a large
     * backlog never becomes one statement too big to finish. A call stops after
     * its row budget; the next call continues. Null when the tables don't exist.
     */
    purge(cutoffS: number): Promise<{
        batches: number;
        sessions: number;
    } | null>;
    /** The switch: null = never set (off); `'missing'` = not set up (off). */
    readSwitch(): Promise<SwitchRow | null | 'missing'>;
    /** Set the switch (`untilMs` null = off); returns the row it replaced and the new one. */
    writeSwitch(untilMs: number | null, who: string, nowS: number): Promise<{
        prior: SwitchRow | null;
        row: SwitchRow;
    }>;
    listSessions(filter: SessionFilter): Promise<SessionPage>;
    sessionDetail(sid: string): Promise<SessionDetail | null>;
}
