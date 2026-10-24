/**
 * The session viewer's model: one line per event, the URL in effect at each
 * moment ("open this view"), and the strip chart's ticks. Pure, so the
 * rendering is pinned by tests.
 */
import { type SessionPage, type StoredEvent } from '../../core/session-log-shape.js';
/** `1h 02m`, `3m 07s`, `12s`, `450ms`. */
export declare function fmtDuration(ms: number): string;
/** `+1:02.345` (offset into the session). */
export declare function fmtOffset(ms: number): string;
/** A local wall-clock time to the ms (`19:43:09.433`), led by the date (`Oct 13 19:43:09.433`) when its day isn't
 *  `startMs`'s (the session header carries the start's date). */
export declare function fmtClock(ms: number, startMs: number, timeZone?: string): string;
/** One event as a line of text. */
export declare function summarize(e: StoredEvent): string;
/** The strip chart's lanes, top to bottom; `app` is the app's own declared events. */
export declare const LANES: readonly ["nav", "input", "app", "api", "error", "page"];
export type Lane = typeof LANES[number];
export declare const laneOf: (e: StoredEvent) => Lane;
export interface Line {
    i: number;
    t: number;
    /** ms since the session's first event. */
    off: number;
    k: StoredEvent['k'];
    text: string;
    error: boolean;
    lane: Lane;
    /** The URL in effect then: the page load's latest `start` / `nav` at or before this event. */
    url: string | null;
    pid: string;
}
/** The session's events as timeline lines (they arrive in time order). */
export declare function timeline(events: readonly StoredEvent[]): Line[];
export interface Tick {
    i: number;
    x: number;
    lane: Lane;
    error: boolean;
}
/** Ticks across `width` px: x by time (a zero-length session puts all at 0). */
export declare function ticks(lines: readonly Line[], width: number): Tick[];
/** A browser + OS label from a User-Agent: enough to tell a phone from a laptop. */
export declare function uaLabel(ua: string | null): string;
/** The list page's filters and cursor (its URL's `u`, `since`, `err`, `after` / `before`) → the API's query string. */
export declare function sessionsQuery(f: {
    email: string;
    since: string;
    errors: boolean;
    after: string | null;
    before: string | null;
}): string;
/** `51–100 of 312`; `0 of 0` when nothing matches; `none of 312` for a page past the end. */
export declare function pagerLabel(p: Pick<SessionPage, 'sessions' | 'total' | 'offset'>): string;
/** `just now`, `5m ago`, `3h ago`, `2d ago`: how long before `now` an epoch-ms instant was. */
export declare function relAgo(ms: number, now?: number): string;
