/**
 * The session logger: a lazily loaded chunk, imported by `bootSessionLog`
 * (`./index.ts`) only while the admin switch is on. `Logger` buffers and
 * flushes (pure: clock, transport and timers are the caller's); `install` wires
 * it to the page (URL changes, clicks on controls, opted-in input fields,
 * pickers, fetches, errors, console errors, viewport and visibility) and
 * returns its undo.
 */
import { type AppEvents, bodySummary, type Kind, type SlogEvent } from '../../core/session-log-shape.js';
export { bodySummary };
export declare const DEFAULT_ENDPOINT = "/api/session-log";
export declare const FLUSH_MS = 10000;
export declare const FILTER_DEBOUNCE_MS = 800;
export declare const RESIZE_DEBOUNCE_MS = 500;
type Fields = Record<string, unknown>;
/** Sends one batch body; `beacon` on page hide. Resolves to the HTTP status (null: unknown / failed). */
export type Send = (body: string, beacon: boolean) => Promise<number | null>;
export declare const tr: (s: unknown, n: number) => string;
export interface LoggerOpts {
    sid: string;
    pid: string;
    build: string;
    /** Epoch ms when logging ends. */
    until: number;
    send: Send;
    /** App events the server accepts; others (and undeclared fields) are dropped here, before they're sent. */
    appEvents?: AppEvents;
    now?: () => number;
}
export declare class Logger {
    readonly sid: string;
    readonly pid: string;
    readonly build: string;
    readonly until: number;
    private send;
    private appEvents;
    private now;
    private buf;
    private seq;
    private dropped;
    private total;
    private timer;
    stopped: boolean;
    /** Called once, on stop (`install`'s undo). */
    onStop: (() => void) | null;
    /** Called before each flush (commit debounced inputs). */
    beforeFlush: (() => void) | null;
    constructor(o: LoggerOpts);
    /** Start the periodic flush. */
    begin(): void;
    /** Record an event (now). Strings past `TRUNC.stack` are cut; nothing else is copied. */
    log(k: Kind, f?: Fields): void;
    /**
     * Record an event with its own timestamp (the boot shim's early errors, a
     * fetch timed from its start). An app event the server didn't declare is
     * dropped, and a declared one keeps only its declared scalar fields.
     */
    push(e: SlogEvent): void;
    /** Send what's buffered, split so each body stays under `LIMITS.batchBytes` (and `batchEvents`). Never awaits
     *  the sends; a 503 (off / expired server-side) stops the logger. */
    flush(beacon: boolean): void;
    /** Stop for good: flush what's buffered (events from before the stop), clear the timer, undo the wiring. */
    stop(): void;
    /** Buffered events (tests). */
    get buffered(): readonly SlogEvent[];
}
/**
 * URL params (lowercase) whose values never leave the page: share-link keys,
 * OAuth codes and tokens, and signed-URL credentials (S3's `X-Amz-*`, GCS's
 * `X-Goog-*`).
 */
export declare const SECRET_PARAMS: string[];
/**
 * A URL as the log keeps it: same-origin → path + query (+ hash), secrets
 * masked; cross-origin → origin + path. `extra`: more param names to mask.
 */
export declare function redactUrl(u: string, origin: string, extra?: readonly string[]): string;
/** A control's log name and label: its `data-log` (nearest), and its `aria-label`, else text, else title. */
export declare function describeControl(el: Element): {
    n?: string;
    l?: string;
};
/** The page surface `install` touches; `window` / `document` in the app, fakes in tests. */
export interface Page {
    win: EventTarget & {
        location: {
            href: string;
            origin: string;
        };
        history: {
            pushState(...a: unknown[]): void;
            replaceState(...a: unknown[]): void;
        };
        innerWidth: number;
        innerHeight: number;
        devicePixelRatio: number;
        fetch: typeof fetch;
    };
    doc: EventTarget & {
        visibilityState: string;
        referrer: string;
    };
    con: {
        error: (...a: unknown[]) => void;
    };
    perfNow: () => number;
}
export interface InstallOptions {
    /** The batch endpoint, whose own requests are never logged (default `/api/session-log`). */
    endpoint?: string;
    /** More URL params to mask, besides `SECRET_PARAMS`. */
    secretParams?: readonly string[];
}
/** Wire `logger` to the page; returns the undo (restores every patch and listener). */
export declare function install(p: Page, logger: Logger, opts?: InstallOptions): () => void;
/** A random id for `sid` / `pid` (`[A-Za-z0-9_-]`). */
export declare const newId: () => string;
/** This tab's session id: kept in `sessionStorage`, so a reload continues the session. */
export declare function tabSid(): string;
/** The transport: `sendBeacon` on page hide, else a `keepalive` POST through the page's own (unwrapped) fetch. */
export declare const transport: (f: typeof fetch, nav: {
    sendBeacon?: (url: string, data: Blob) => boolean;
}, endpoint?: string) => Send;
export interface StartOptions extends InstallOptions {
    /** Epoch ms when logging ends (the server's `until`). */
    until: number;
    /** What the boot shim held while it decided. */
    early: SlogEvent[];
    /** The app's build id, recorded on every batch. */
    build: string;
    appEvents?: AppEvents;
}
/** Start logging on this page until `until`. Returns the `slog` sink. */
export declare function start(o: StartOptions): {
    log: (k: Kind, f?: Fields) => void;
    logger: Logger;
};
