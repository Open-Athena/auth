/**
 * The session viewer's model: one line per event, the URL in effect at each
 * moment ("open this view"), and the strip chart's ticks. Pure, so the
 * rendering is pinned by tests.
 */
import { isCancelled, isErrorEvent, KINDS } from '../../core/session-log-shape.js';
const onHint = (v) => (v === true ? 'online hint' : v === false ? 'offline hint' : 'connectivity unknown');
/** No response (other than the page's own cancel) or a 5xx, whether or not it counts as an error. */
const noGood = (e) => e.k === 'api' && typeof e.s === 'number' && (e.s >= 500 || (e.s === 0 && !isCancelled(e)));
/** Two-unit durations: `4d 12h`, `1h 02m`, `3m 07s`, `12s`, `450ms`. */
export function fmtDuration(ms) {
    if (ms < 1000)
        return `${Math.round(ms)}ms`;
    const s = Math.floor(ms / 1000);
    if (s < 60)
        return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60)
        return `${m}m ${String(s % 60).padStart(2, '0')}s`;
    const h = Math.floor(m / 60);
    return h < 24 ? `${h}h ${String(m % 60).padStart(2, '0')}m` : `${Math.floor(h / 24)}d ${String(h % 24).padStart(2, '0')}h`;
}
/** Millisecond precision under a minute; compact two-unit offsets afterward. */
export function fmtOffset(ms) {
    const t = Math.max(0, Math.round(ms));
    return `+${t < 60_000 ? `${(t / 1000).toFixed(3)}s` : fmtDuration(t)}`;
}
/** A local wall-clock time to the ms (`19:43:09.433`), led by the date (`Oct 13 19:43:09.433`) when its day isn't
 *  `startMs`'s (the session header carries the start's date). */
export function fmtClock(ms, startMs, timeZone) {
    const day = (t) => new Date(t).toLocaleDateString('en-CA', { timeZone });
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZone })
        .formatToParts(new Date(ms)).map(x => [x.type, x.value]));
    const clock = `${p.hour}:${p.minute}:${p.second}.${String(((Math.round(ms) % 1000) + 1000) % 1000).padStart(3, '0')}`;
    if (day(ms) === day(startMs))
        return clock;
    return `${new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone })} ${clock}`;
}
const str = (v) => (v === undefined || v === null ? '' : String(v));
/** One event as a line of text. */
export function summarize(e) {
    switch (e.k) {
        case 'start': return `page load ${str(e.u)}${e.ref ? ` (from ${str(e.ref)})` : ''}`;
        case 'nav': return str(e.u);
        case 'click': return [e.n && `[${str(e.n)}]`, str(e.l), e.x !== undefined && (e.x ? '☑' : '☐')].filter(Boolean).join(' ');
        case 'filter': return `${str(e.n)} = “${str(e.q)}”`;
        case 'pick': return `${str(e.n)} → ${str(e.v)}`;
        case 'prefetch': return `${str(e.w)} ${str(e.p) || '(root)'}${e.d ? ` @ ${str(e.d)}` : ''}`;
        case 'api': {
            const b = e.b && typeof e.b === 'object' ? ` {${Object.entries(e.b).map(([k, v]) => `${k}: ${v}`).join(', ')}}` : '';
            // For a request that got nothing usable: what the browser said about connectivity, visibility and timers.
            const context = e.s === 0 || noGood(e)
                ? [
                    e.on0 !== undefined && `${onHint(e.on0)}${e.on0 !== e.on ? ` → ${onHint(e.on)}` : ''}`,
                    e.vis0 && `${str(e.vis0)}${e.vis0 !== e.vis ? ` → ${str(e.vis)}` : ''}`,
                    typeof e.visMs === 'number' && `${fmtDuration(e.visMs)} since visible`,
                    typeof e.gapMs === 'number' && `timer gap ${fmtDuration(e.gapMs)}, ${fmtDuration(Number(e.gapAgo))} before request`,
                    e.cancel && `cancel: ${str(e.cancel)}`,
                ].filter(Boolean)
                : [];
            return [
                `${str(e.m) || 'GET'} ${str(e.u)}${b} → ${isCancelled(e) ? 'cancelled' : e.s === 0 ? 'failed' : str(e.s)} · ${str(e.ms)}ms`,
                e.c && str(e.c),
                e.qe && str(e.qe),
                e.err && !isCancelled(e) && str(e.err),
                e.id && `request #${str(e.id)}`,
                ...context,
                e.ray && `Ray ${str(e.ray)}`,
                typeof e.wall === 'number' && Math.abs(e.wall - Number(e.ms)) > 1000 && `wall ${fmtDuration(e.wall)}`,
            ].filter(Boolean).join(' · ');
        }
        case 'life':
            return [
                `browser ${str(e.s)}${typeof e.ms === 'number' ? ` ${fmtDuration(e.ms)}` : ''}`,
                onHint(e.on),
                str(e.vis),
                e.persisted === true && 'bfcache',
                e.discarded === true && 'previously discarded',
            ].filter(Boolean).join(' · ');
        case 'error': return `${str(e.msg)}${e.src ? ` @ ${str(e.src)}` : ''}`;
        case 'reject': return `unhandled rejection: ${str(e.msg)}`;
        case 'console': return `console.error: ${str(e.msg)}`;
        case 'viewport': return `${str(e.w)}×${str(e.h)} @${str(e.dpr)}x`;
        case 'vis': return `tab ${str(e.s)}`;
        case 'dropped': return `${str(e.n)} events dropped (cap)`;
        default: {
            // An app event: its fields, in the order sent.
            const f = Object.entries(e).filter(([k]) => !['t', 'k', 'pid', 'seq', '_received_ms'].includes(k));
            return f.map(([k, v]) => `${k}: ${str(v)}`).join(' · ');
        }
    }
}
const BUILTIN = new Set(KINDS);
/** The strip chart's lanes, top to bottom; `app` is the app's own declared events. */
export const LANES = ['nav', 'input', 'app', 'api', 'error', 'page'];
export const laneOf = (e) => isErrorEvent(e, e._received_ms) ? 'error'
    : e.k === 'start' || e.k === 'nav' ? 'nav'
        : e.k === 'click' || e.k === 'filter' || e.k === 'pick' || e.k === 'prefetch' ? 'input'
            : e.k === 'api' ? 'api'
                : BUILTIN.has(e.k) ? 'page'
                    : 'app';
/** The session's events as timeline lines (they arrive in time order). */
export function timeline(events) {
    const t0 = events[0]?.t ?? 0;
    const urlBy = new Map();
    const failed = new Map();
    return events.map((e, i) => {
        if ((e.k === 'start' || e.k === 'nav') && typeof e.u === 'string')
            urlBy.set(e.pid, e.u);
        // A later success for the same read: only an exact, unmasked, same-origin GET / HEAD on the same page load,
        // started after the failure ended. Never a write or an earlier concurrent request; the failure stays as it was.
        let later = '';
        if (e.k === 'api' && typeof e.id === 'number' && typeof e.u === 'string' && e.u.startsWith('/') && !e.u.includes('…') && ['GET', 'HEAD'].includes(String(e.m ?? 'GET'))) {
            const key = JSON.stringify([e.pid, e.m ?? 'GET', e.u]);
            const prior = failed.get(key);
            if (noGood(e) && typeof e.end === 'number')
                failed.set(key, { id: e.id, end: e.end });
            else if (typeof e.s === 'number' && e.s >= 200 && e.s < 300 && prior && e.t >= prior.end) {
                later = ` · later success after request #${prior.id} (${fmtDuration(e.t - prior.end)} after failure)`;
                failed.delete(key);
            }
        }
        return { i, t: e.t, off: e.t - t0, k: e.k, text: summarize(e) + later, error: isErrorEvent(e, e._received_ms), lane: laneOf(e), url: urlBy.get(e.pid) ?? null, pid: e.pid };
    });
}
/** Ticks across `width` px: x by time (a zero-length session puts all at 0). */
export function ticks(lines, width) {
    const span = lines[lines.length - 1]?.off ?? 0;
    return lines.map(l => ({ i: l.i, x: span ? Math.round((l.off / span) * width * 10) / 10 : 0, lane: l.lane, error: l.error }));
}
/** A browser + OS label from a User-Agent: enough to tell a phone from a laptop. */
export function uaLabel(ua) {
    if (!ua)
        return '—';
    const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'other';
    const os = /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'other';
    return `${browser} · ${os}`;
}
/** The list page's filters and cursor (its URL's `u`, `since`, `err`, `after` / `before`) → the API's query string. */
export function sessionsQuery(f) {
    const q = new URLSearchParams();
    if (f.email)
        q.set('email', f.email);
    if (f.since)
        q.set('since', f.since);
    if (f.errors)
        q.set('errors', '1');
    if (f.after)
        q.set('after', f.after);
    else if (f.before)
        q.set('before', f.before);
    return q.toString();
}
/** `51–100 of 312`; `0 of 0` when nothing matches; `none of 312` for a page past the end. */
export function pagerLabel(p) {
    const total = p.total.toLocaleString('en-US');
    if (!p.sessions.length)
        return p.total ? `none of ${total}` : '0 of 0';
    return `${(p.offset + 1).toLocaleString('en-US')}–${(p.offset + p.sessions.length).toLocaleString('en-US')} of ${total}`;
}
/** `just now`, `5m ago`, `3h ago`, `2d ago`: how long before `now` an epoch-ms instant was. */
export function relAgo(ms, now = Date.now()) {
    const s = Math.max(0, Math.round((now - ms) / 1000));
    if (s < 45)
        return 'just now';
    const m = Math.round(s / 60);
    if (m < 60)
        return `${m}m ago`;
    const h = Math.round(m / 60);
    if (h < 36)
        return `${h}h ago`;
    return `${Math.round(h / 24)}d ago`;
}
