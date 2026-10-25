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
export const BUILTIN_FIELDS = {
    start: ['u', 'ref'],
    nav: ['u'],
    click: ['n', 'l', 'x'],
    filter: ['n', 'q'],
    pick: ['n', 'v'],
    prefetch: ['w', 'p', 'd'],
    api: ['m', 'u', 's', 'ms', 'c', 'qe', 'err', 'b'],
    error: ['msg', 'src', 'st'],
    reject: ['msg', 'st'],
    console: ['msg'],
    viewport: ['w', 'h', 'dpr'],
    vis: ['s'],
    dropped: ['n'],
};
export const KINDS = Object.keys(BUILTIN_FIELDS);
/** An app event's name: lowercase, dotted, and not a built-in kind. */
export const APP_EVENT_NAME = /^[a-z][a-z0-9_]*(?:[.-][a-z0-9_]+)*$/;
/** Throws on a malformed declaration, so a typo fails at startup, not as a 400 per batch. */
export function checkAppEvents(app) {
    for (const [name, fields] of Object.entries(app)) {
        if (name.length > 40 || !APP_EVENT_NAME.test(name))
            throw new Error(`session log: bad app event name ${JSON.stringify(name)}`);
        if (name in BUILTIN_FIELDS)
            throw new Error(`session log: app event ${name} shadows a built-in kind`);
        for (const f of fields) {
            if (f === 't' || f === 'k' || !/^[A-Za-z][A-Za-z0-9_]{0,29}$/.test(f)) {
                throw new Error(`session log: app event ${name}: bad field ${JSON.stringify(f)}`);
            }
        }
    }
    return app;
}
export const LIMITS = {
    /** Server: request body bytes (`sendBeacon` / `keepalive` budgets are 64 KiB). */
    bodyBytes: 65_536,
    /** Client: a post's body stays under this (several posts otherwise). */
    batchBytes: 60_000,
    /** Server: events per batch. */
    batchEvents: 300,
    /** Client: flush once this many are buffered. */
    flushEvents: 200,
    /** Server: events stored per session; client: per page load. */
    sessionEvents: 20_000,
    /** Server: one event's serialized size. */
    eventBytes: 4096,
    /** The switch's latest dated end: through the UTC day this many days ahead (`FOREVER_MS` is the undated one). */
    maxDays: 31,
    /** The switch's end when turned on with no date. */
    defaultDays: 7,
};
/** Client-side truncation, per field family. */
export const TRUNC = { label: 60, filter: 200, url: 300, msg: 300, stack: 1500 };
/** Kinds (and api statuses) that count as errors in the session summary. */
export const isErrorEvent = (e) => e.k === 'error' ||
    e.k === 'reject' ||
    e.k === 'console' ||
    (e.k === 'api' && typeof e.s === 'number' && (e.s === 0 || e.s >= 500));
const ID = /^[A-Za-z0-9_-]{6,40}$/;
/** The end (exclusive) of the UTC day `days` after `now`'s. */
export const endOfUtcDay = (now, days) => {
    const d = new Date(now);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + days + 1);
};
/** Turning the switch on with no date: through the UTC day `LIMITS.defaultDays` from now. */
export const defaultUntil = (now) => endOfUtcDay(now, LIMITS.defaultDays);
/** The latest an admin may set: through the UTC day `LIMITS.maxDays` from now. */
export const maxUntil = (now) => endOfUtcDay(now, LIMITS.maxDays);
/**
 * The switch's "no end date": stored as this `until_ms` (2100-01-01T00:00Z),
 * not NULL (NULL is off), so every reader that only compares `until_ms` with
 * its clock needs no special case: it never passes. Any stored value at or past
 * it reads as indefinite. Dated ends stay within `LIMITS.maxDays`.
 */
export const FOREVER_MS = Date.UTC(2100, 0, 1);
export const isForever = (until) => until !== null && until >= FOREVER_MS;
/** The UTC date (`YYYY-MM-DD`) an exclusive end instant runs through. */
export const lastDay = (until) => new Date(until - 1).toISOString().slice(0, 10);
/**
 * An admin's `until` → the instant logging ends (epoch ms), or why it's
 * refused. A bare date runs through that UTC day; an ISO instant ends at it;
 * empty = `defaultUntil`. Past, or past `maxUntil`, is refused (a typo can't
 * turn it on for a year).
 */
export function parseUntil(raw, now) {
    const s = raw?.trim();
    if (!s)
        return { until: defaultUntil(now) };
    const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    const until = day ? Date.UTC(+day[1], +day[2] - 1, +day[3] + 1) : Date.parse(s);
    if (!Number.isFinite(until))
        return { error: `unparseable until: ${s}` };
    if (until <= now)
        return { error: `until ${s} is in the past` };
    if (until > maxUntil(now)) {
        return { error: `until ${s} is more than ${LIMITS.maxDays} days ahead (latest: ${lastDay(maxUntil(now))})` };
    }
    return { until };
}
/** The stored switch (`until_ms`; null = off, or no row) → whether it's on now, or why not. */
export function switchState(untilMs, now) {
    if (untilMs === null)
        return { until: null, reason: 'off' };
    if (untilMs <= now)
        return { until: untilMs, reason: 'expired' };
    return { until: untilMs, reason: null };
}
export const isOn = (u) => u.until !== null && u.reason === null;
const isScalar = (v) => v === null || ['string', 'number', 'boolean'].includes(typeof v);
/** A posted body → the batch, or the status and reason it's refused with. */
export function validateBatch(raw, app = {}) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
        return { status: 400, error: 'body must be a JSON object' };
    const b = raw;
    if (typeof b.sid !== 'string' || !ID.test(b.sid))
        return { status: 400, error: 'bad sid' };
    if (typeof b.pid !== 'string' || !ID.test(b.pid))
        return { status: 400, error: 'bad pid' };
    if (!Number.isInteger(b.seq) || b.seq < 0 || b.seq > 1_000_000) {
        return { status: 400, error: 'bad seq' };
    }
    if (typeof b.build !== 'string' || b.build.length > 40)
        return { status: 400, error: 'bad build' };
    if (!Array.isArray(b.events) || !b.events.length)
        return { status: 400, error: 'events must be a non-empty array' };
    if (b.events.length > LIMITS.batchEvents)
        return { status: 413, error: `more than ${LIMITS.batchEvents} events` };
    for (const [i, e] of b.events.entries()) {
        if (!e || typeof e !== 'object' || Array.isArray(e))
            return { status: 400, error: `event ${i}: not an object` };
        const ev = e;
        if (typeof ev.t !== 'number' || !Number.isFinite(ev.t))
            return { status: 400, error: `event ${i}: bad t` };
        const k = typeof ev.k === 'string' ? ev.k : '';
        const builtin = Object.hasOwn(BUILTIN_FIELDS, k) ? BUILTIN_FIELDS[k] : null;
        const declared = builtin ?? (Object.hasOwn(app, k) ? app[k] : null);
        if (!declared)
            return { status: 400, error: `event ${i}: unknown kind ${String(ev.k).slice(0, 40)}` };
        for (const [key, v] of Object.entries(ev)) {
            if (key === 't' || key === 'k')
                continue;
            if (!declared.includes(key))
                return { status: 400, error: `event ${i}: undeclared field ${key.slice(0, 30)}` };
            // One level of nesting, and only on the api event's request-body summary (`b`).
            const nested = builtin !== null &&
                k === 'api' &&
                key === 'b' &&
                v !== null &&
                typeof v === 'object' &&
                !Array.isArray(v) &&
                Object.values(v).every(x => typeof x === 'string' || typeof x === 'number');
            if (!isScalar(v) && !nested)
                return { status: 400, error: `event ${i}: bad field ${key.slice(0, 30)}` };
        }
        if (JSON.stringify(ev).length > LIMITS.eventBytes)
            return { status: 413, error: `event ${i}: over ${LIMITS.eventBytes} bytes` };
    }
    return { batch: { sid: b.sid, pid: b.pid, seq: b.seq, build: b.build, events: b.events } };
}
/** A cursor on the wire and in the page URL: `<last_ms>.<sid>` (sids never hold a `.`). */
export const fmtCursor = (r) => `${r.last_ms}.${r.sid}`;
export function parseCursor(s) {
    const m = /^(\d{1,16})\.([A-Za-z0-9_-]{6,40})$/.exec(s);
    return m ? { lastMs: Number(m[1]), sid: m[2] } : null;
}
/** Sessions per page (the list API's default `limit`; at most `SESSIONS_MAX_LIMIT`). */
export const SESSIONS_PAGE = 50;
export const SESSIONS_MAX_LIMIT = 500;
const cut = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const KIND_KEYS = new Set(['kind', 'op', 'action', 'mode']);
/**
 * A JSON request body as counts and kinds only: per top-level key, an array's
 * length, a short `kind`-like string, else the value's type. Not JSON (or not
 * an object) → its type and length.
 */
export function bodySummary(body) {
    if (body == null)
        return null;
    if (typeof body !== 'string')
        return { type: Object.prototype.toString.call(body).slice(8, -1) };
    let j;
    try {
        j = JSON.parse(body);
    }
    catch {
        return { type: 'text', len: body.length };
    }
    if (!j || typeof j !== 'object' || Array.isArray(j)) {
        return Array.isArray(j) ? { type: 'array', len: j.length } : { type: typeof j };
    }
    const out = {};
    for (const [k, v] of Object.entries(j).slice(0, 12)) {
        out[cut(k, 30)] = Array.isArray(v)
            ? v.length
            : KIND_KEYS.has(k) && typeof v === 'string'
                ? cut(v, 30)
                : v === null
                    ? 'null'
                    : typeof v;
    }
    return out;
}
