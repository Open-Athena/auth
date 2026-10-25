/**
 * The session log's wire shape and limits, shared by the client logger
 * (`/session-log/client`), the endpoint (`/session-log`), the D1 store
 * (`/session-log/d1`) and the viewer (`/react/session-log`). Pure: no Workers
 * or DOM types, so every one of those builds can import it.
 *
 * An event log, not a screen recorder: page loads, URL changes, clicks on
 * controls, opted-in input fields, requests, errors, viewport and visibility,
 * plus whatever app events the app declares (each with its own field list).
 * Never DOM snapshots, keystrokes, form contents, headers or request bodies.
 */
/** Built-in event kinds and the fields each may carry (besides `t` and `k`). Anything else is a 400. */
export declare const BUILTIN_FIELDS: {
    readonly start: readonly ["u", "ref"];
    readonly nav: readonly ["u"];
    readonly click: readonly ["n", "l", "x"];
    readonly filter: readonly ["n", "q"];
    readonly pick: readonly ["n", "v"];
    readonly prefetch: readonly ["w", "p", "d"];
    readonly api: readonly ["m", "u", "s", "ms", "c", "qe", "err", "b"];
    readonly error: readonly ["msg", "src", "st"];
    readonly reject: readonly ["msg", "st"];
    readonly console: readonly ["msg"];
    readonly viewport: readonly ["w", "h", "dpr"];
    readonly vis: readonly ["s"];
    readonly dropped: readonly ["n"];
};
export type BuiltinKind = keyof typeof BUILTIN_FIELDS;
export declare const KINDS: BuiltinKind[];
/** A built-in kind, or an app event's name. */
export type Kind = BuiltinKind | (string & {});
/**
 * App events an app declares, by name, with the fields each may carry: e.g.
 * `{ 'movie.queued': ['query', 'format'] }`. The client drops undeclared
 * fields before sending; the server refuses an undeclared name or field. Field
 * values are scalars (string, number, boolean, null), never objects: a declared
 * schema can't smuggle a credential-bearing blob.
 */
export type AppEvents = Readonly<Record<string, readonly string[]>>;
/** An app event's name: lowercase, dotted, and not a built-in kind. */
export declare const APP_EVENT_NAME: RegExp;
/** Throws on a malformed declaration, so a typo fails at startup, not as a 400 per batch. */
export declare function checkAppEvents(app: AppEvents): AppEvents;
type Scalar = string | number | boolean | null;
/** One event: a client timestamp (epoch ms), a kind, and the kind's short fields. */
export type SlogEvent = {
    t: number;
    k: Kind;
} & Record<string, Scalar | Record<string, string | number>>;
/** One client flush. `sid` is per tab (survives reloads), `pid` per page load, `seq` per flush of that load. */
export interface SlogBatch {
    sid: string;
    pid: string;
    seq: number;
    build: string;
    events: SlogEvent[];
}
export declare const LIMITS: {
    /** Server: request body bytes (`sendBeacon` / `keepalive` budgets are 64 KiB). */
    readonly bodyBytes: 65536;
    /** Client: a post's body stays under this (several posts otherwise). */
    readonly batchBytes: 60000;
    /** Server: events per batch. */
    readonly batchEvents: 300;
    /** Client: flush once this many are buffered. */
    readonly flushEvents: 200;
    /** Server: events stored per session; client: per page load. */
    readonly sessionEvents: 20000;
    /** Server: one event's serialized size. */
    readonly eventBytes: 4096;
    /** The switch's latest dated end: through the UTC day this many days ahead (`FOREVER_MS` is the undated one). */
    readonly maxDays: 31;
    /** The switch's end when turned on with no date. */
    readonly defaultDays: 7;
};
/** Client-side truncation, per field family. */
export declare const TRUNC: {
    readonly label: 60;
    readonly filter: 200;
    readonly url: 300;
    readonly msg: 300;
    readonly stack: 1500;
};
/** Kinds (and api statuses) that count as errors in the session summary. */
export declare const isErrorEvent: (e: {
    k: Kind;
    s?: unknown;
}) => boolean;
/** The end (exclusive) of the UTC day `days` after `now`'s. */
export declare const endOfUtcDay: (now: number, days: number) => number;
/** Turning the switch on with no date: through the UTC day `LIMITS.defaultDays` from now. */
export declare const defaultUntil: (now: number) => number;
/** The latest an admin may set: through the UTC day `LIMITS.maxDays` from now. */
export declare const maxUntil: (now: number) => number;
/**
 * The switch's "no end date": stored as this `until_ms` (2100-01-01T00:00Z),
 * not NULL (NULL is off), so every reader that only compares `until_ms` with
 * its clock needs no special case: it never passes. Any stored value at or past
 * it reads as indefinite. Dated ends stay within `LIMITS.maxDays`.
 */
export declare const FOREVER_MS: number;
export declare const isForever: (until: number | null) => boolean;
/** The UTC date (`YYYY-MM-DD`) an exclusive end instant runs through. */
export declare const lastDay: (until: number) => string;
/**
 * An admin's `until` → the instant logging ends (epoch ms), or why it's
 * refused. A bare date runs through that UTC day; an ISO instant ends at it;
 * empty = `defaultUntil`. Past, or past `maxUntil`, is refused (a typo can't
 * turn it on for a year).
 */
export declare function parseUntil(raw: string | null | undefined, now: number): {
    until: number;
} | {
    error: string;
};
/** The stored switch (`until_ms`; null = off, or no row) → whether it's on now, or why not. */
export declare function switchState(untilMs: number | null, now: number): {
    until: number | null;
    reason: string | null;
};
export declare const isOn: (u: {
    until: number | null;
    reason: string | null;
}) => boolean;
/**
 * `GET` / `PUT <base>/switch` (admin): the switch now, who last set it (epoch
 * s), and the bounds a new `until` must sit in. `indefinite`: on with no end
 * date (`until` is then `FOREVER_MS`, or the far-future value stored).
 */
export interface SwitchState {
    enabled: boolean;
    until: number | null;
    indefinite: boolean;
    reason: string | null;
    who: string | null;
    ts: number | null;
    defaultUntil: number;
    maxUntil: number;
}
/** `GET <base>` (anyone): whether this request's tab should log. `enabled` only for an identified viewer. */
export interface SessionLogConfig {
    enabled: boolean;
    until: number | null;
    reason: string | null;
    /** The switch is on for every identified viewer (a privacy page can say so). */
    on: boolean;
    retainDays: number;
    /** The app events this deployment accepts, so the client drops anything else before sending. */
    appEvents: AppEvents;
}
/** A posted body → the batch, or the status and reason it's refused with. */
export declare function validateBatch(raw: unknown, app?: AppEvents): {
    batch: SlogBatch;
} | {
    status: 400 | 413;
    error: string;
};
/** The session summary row (`session_log`), as the admin APIs return it. */
export interface SessionRow {
    sid: string;
    email: string | null;
    via: string | null;
    build: string | null;
    ua: string | null;
    started_ms: number;
    last_ms: number;
    n_events: number;
    n_errors: number;
    n_batches: number;
    first_url: string | null;
    received_ts: number;
}
/** A position in the session list's order (`last_ms` desc, then `sid`): a row's `last_ms` and `sid`. */
export interface Cursor {
    lastMs: number;
    sid: string;
}
/** A cursor on the wire and in the page URL: `<last_ms>.<sid>` (sids never hold a `.`). */
export declare const fmtCursor: (r: Pick<SessionRow, "last_ms" | "sid">) => string;
export declare function parseCursor(s: string): Cursor | null;
/** Sessions per page (the list API's default `limit`; at most `SESSIONS_MAX_LIMIT`). */
export declare const SESSIONS_PAGE = 50;
export declare const SESSIONS_MAX_LIMIT = 500;
/**
 * `GET <base>/sessions`: one page, most recently active first. `total` = rows
 * matching the filters, `offset` = how many of them precede this page; `prev` /
 * `next` are the cursors (`before=` / `after=`) of the adjacent pages, null at
 * either end.
 */
export interface SessionPage {
    sessions: SessionRow[];
    total: number;
    offset: number;
    prev: string | null;
    next: string | null;
}
/** A stored event with where it came from (the page load and batch), as the session view gets it. */
export type StoredEvent = SlogEvent & {
    pid: string;
    seq: number;
};
/** `GET <base>/sessions/:sid`. */
export interface SessionDetail {
    session: SessionRow;
    events: StoredEvent[];
}
/**
 * A JSON request body as counts and kinds only: per top-level key, an array's
 * length, a short `kind`-like string, else the value's type. Not JSON (or not
 * an object) → its type and length.
 */
export declare function bodySummary(body: unknown): Record<string, string | number> | null;
export {};
