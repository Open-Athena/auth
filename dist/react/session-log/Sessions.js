import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { memo, useCallback, useMemo, useRef, useState } from 'react';
import { fmtClock, fmtDuration, fmtOffset, LANES, pagerLabel, relAgo, sessionsQuery, ticks, timeline, uaLabel, } from './model.js';
async function getJson(url) {
    const r = await fetch(url, { credentials: 'same-origin' });
    const j = await r.json().catch(() => ({}));
    if (!r.ok)
        throw new Error(j.error ?? `HTTP ${r.status}`);
    return j;
}
const fmtTime = (ms) => new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' });
const plainLink = ({ href, className, children }) => (_jsx("a", { href: href, className: className, children: children }));
/** Who a session was, by default: the address, else "anonymous", and a share-link session is tagged as such. */
export function DefaultViewer({ s }) {
    return (_jsxs("span", { className: "oa-slog-who", children: [s.email ? _jsx("span", { children: s.email }) : s.via !== 'grant' && _jsx("em", { children: "anonymous" }), s.via === 'grant' && (_jsxs(_Fragment, { children: [s.email && _jsx("span", { className: "oa-slog-dim", children: " \u00B7 " }), _jsxs("span", { className: "oa-slog-guest", children: ["share link", s.email ? '' : ', no address'] })] }))] }));
}
export const EMPTY_PARAMS = { email: '', since: '', errors: false, after: null, before: null };
/** Sessions, most recently active first, 50 a page, filterable by address, start date and errors. */
export function SessionList({ endpoint = '/api/session-log', params: controlled, onParams, sessionHref, renderLink = plainLink, renderViewer = s => _jsx(DefaultViewer, { s: s }), className = 'oa-slog', }) {
    const [own, setOwn] = useState(EMPTY_PARAMS);
    const params = controlled ?? own;
    const update = (next, replace) => (onParams ? onParams(next, { replace }) : setOwn(next));
    /** A filter change returns to the first page. */
    const set = (patch) => update({ ...params, ...patch, after: null, before: null }, true);
    const go = (k, c) => update({ ...params, after: k === 'after' ? c : null, before: k === 'before' ? c : null }, false);
    const qs = sessionsQuery(params);
    const q = useQuery({
        queryKey: ['oa-session-log', endpoint, 'sessions', qs],
        queryFn: () => getJson(`${endpoint}/sessions${qs ? `?${qs}` : ''}`),
        placeholderData: keepPreviousData,
    });
    const pager = q.data && _jsx(Pager, { page: q.data, onGo: go });
    return (_jsxs("div", { className: className, children: [_jsxs("div", { className: "oa-slog-filters", children: [_jsxs("label", { children: ["viewer", ' ', _jsx("input", { type: "search", name: "oa-slog-viewer", autoComplete: "off", "data-1p-ignore": "", "data-lpignore": "true", value: params.email, onChange: e => set({ email: e.target.value }), placeholder: "address contains\u2026", size: 22 })] }), _jsxs("label", { children: ["active since ", _jsx("input", { type: "date", value: params.since, onChange: e => set({ since: e.target.value }) })] }), _jsxs("label", { children: [_jsx("input", { type: "checkbox", checked: params.errors, onChange: e => set({ errors: e.target.checked }) }), " with errors"] })] }), q.error && _jsx("p", { className: "oa-slog-err", children: q.error.message }), pager, _jsx("div", { className: "oa-slog-scroll", children: _jsxs("table", { className: "oa-slog-table", children: [_jsx("thead", { children: _jsxs("tr", { children: [_jsx("th", { children: "viewer" }), _jsx("th", { children: "last active" }), _jsx("th", { children: "started" }), _jsx("th", { className: "oa-slog-num", children: "duration" }), _jsx("th", { className: "oa-slog-num", children: "events" }), _jsx("th", { className: "oa-slog-num", children: "errors" }), _jsx("th", { children: "browser" }), _jsx("th", { children: "build" })] }) }), _jsxs("tbody", { children: [(q.data?.sessions ?? []).map(s => (_jsxs("tr", { className: s.n_errors ? 'oa-slog-has-err' : '', children: [_jsx("td", { children: renderViewer(s) }), _jsxs("td", { children: [renderLink({ href: sessionHref(s.sid), className: 'oa-slog-when', children: relAgo(s.last_ms) }), _jsx("div", { className: "oa-slog-dim", children: fmtTime(s.last_ms) })] }), _jsx("td", { children: fmtTime(s.started_ms) }), _jsx("td", { className: "oa-slog-num", children: fmtDuration(s.last_ms - s.started_ms) }), _jsx("td", { className: "oa-slog-num", children: s.n_events.toLocaleString() }), _jsx("td", { className: "oa-slog-num", children: s.n_errors ? _jsx("b", { className: "oa-slog-err", children: s.n_errors }) : _jsx("span", { className: "oa-slog-dim", children: "0" }) }), _jsx("td", { children: uaLabel(s.ua) }), _jsx("td", { children: _jsx("code", { children: s.build ?? '—' }) })] }, s.sid))), q.data && !q.data.sessions.length && (_jsx("tr", { children: _jsx("td", { colSpan: 8, children: _jsx("em", { children: "no sessions match" }) }) })), q.isPending && (_jsx("tr", { children: _jsx("td", { colSpan: 8, className: "oa-slog-dim", children: "Loading sessions\u2026" }) }))] })] }) }), q.data && q.data.sessions.length > 10 && pager] }));
}
/** "51–100 of 312" with prev / next: the page's cursors (`prev` / `next`), disabled at either end. */
function Pager({ page, onGo }) {
    const { prev, next } = page;
    return (_jsxs("nav", { className: "oa-slog-pager", "aria-label": "Pages", children: [_jsx("button", { type: "button", disabled: !prev, onClick: () => prev && onGo('before', prev), children: "\u2190 newer" }), _jsx("span", { children: pagerLabel(page) }), _jsx("button", { type: "button", disabled: !next, onClick: () => next && onGo('after', next), children: "older \u2192" })] }));
}
const KIND_FILTERS = [
    { id: 'all', label: 'all' },
    { id: 'errors', label: 'errors' },
    { id: 'actions', label: 'actions' },
    { id: 'app', label: 'app' },
    { id: 'api', label: 'requests' },
];
const shown = (l, f) => f === 'all' ||
    (f === 'errors'
        ? l.error
        : f === 'actions'
            ? l.lane === 'input' || l.lane === 'nav'
            : f === 'app'
                ? l.lane === 'app'
                : l.k === 'api');
/** One session: a strip of its events over time, then the timeline table, each row with "open this view". */
export function SessionView({ sid, endpoint = '/api/session-log', renderViewer = s => _jsx(DefaultViewer, { s: s }), className = 'oa-slog', }) {
    const q = useQuery({
        queryKey: ['oa-session-log', endpoint, 'session', sid],
        queryFn: () => getJson(`${endpoint}/sessions/${encodeURIComponent(sid)}`),
    });
    const lines = useMemo(() => timeline(q.data?.events ?? []), [q.data]);
    const [filter, setFilter] = useState('all');
    const [focus, setFocus] = useState(null);
    /** The event under the pointer, in the strip or the table: both highlight it. */
    const [hot, setHot] = useState(null);
    const rows = useRef(new Map());
    const box = useRef(null);
    const rowRef = useCallback((i, el) => {
        if (el)
            rows.current.set(i, el);
        else
            rows.current.delete(i);
    }, []);
    /** A strip hover brings its row into the table's own scroll box (never the page's: the strip stays in view). */
    const stripHover = useCallback((i) => {
        setHot(i);
        const row = i === null ? undefined : rows.current.get(i);
        const b = box.current;
        if (!row || !b)
            return;
        const r = row.getBoundingClientRect();
        const bb = b.getBoundingClientRect();
        const head = b.querySelector('thead')?.getBoundingClientRect().height ?? 0;
        if (r.top < bb.top + head || r.bottom > bb.bottom)
            b.scrollTop += r.top - bb.top - (bb.height - r.height) / 2;
    }, []);
    if (q.error)
        return _jsx("p", { className: "oa-slog-err", children: q.error.message });
    if (!q.data)
        return _jsx("p", { className: "oa-slog-dim", children: "Loading session\u2026" });
    const s = q.data.session;
    const t0 = lines[0]?.t ?? s.started_ms;
    const jump = (i) => {
        setFilter('all');
        setFocus(i);
        requestAnimationFrame(() => rows.current.get(i)?.scrollIntoView({ block: 'center', behavior: 'smooth' }));
    };
    return (_jsxs("div", { className: className, children: [_jsx("h1", { children: renderViewer(s) }), _jsxs("p", { className: "oa-slog-meta", children: [fmtTime(s.started_ms), " \u00B7 ", fmtDuration(s.last_ms - s.started_ms), " \u00B7 ", s.n_events.toLocaleString(), " events \u00B7", ' ', s.n_errors ? _jsxs("b", { className: "oa-slog-err", children: [s.n_errors, " ", s.n_errors === 1 ? 'error' : 'errors'] }) : '0 errors', " \u00B7 ", uaLabel(s.ua), " \u00B7 build", ' ', _jsx("code", { children: s.build ?? '—' }), " \u00B7 ", _jsx("code", { className: "oa-slog-dim", children: s.sid })] }), _jsx(Strip, { lines: lines, hot: hot, onHover: stripHover, onPick: jump }), _jsx("div", { className: "oa-slog-filters", role: "radiogroup", "aria-label": "Show", children: KIND_FILTERS.map(f => (_jsxs("label", { children: [_jsx("input", { type: "radio", name: "oa-slog-kind", checked: filter === f.id, onChange: () => setFilter(f.id) }), " ", f.label] }, f.id))) }), _jsx("div", { className: "oa-slog-scroll oa-slog-timeline-box", ref: box, children: _jsxs("table", { className: "oa-slog-table oa-slog-timeline", children: [_jsx("thead", { children: _jsxs("tr", { children: [_jsx("th", { className: "oa-slog-num", children: "at" }), _jsx("th", { className: "oa-slog-num", children: "time" }), _jsx("th", { children: "kind" }), _jsx("th", { children: "event" }), _jsx("th", {})] }) }), _jsx("tbody", { onMouseLeave: () => setHot(null), children: lines
                                .filter(l => shown(l, filter))
                                .map(l => (_jsx(EventRow, { l: l, t0: t0, hot: hot === l.i, focused: focus === l.i, rowRef: rowRef, onHover: setHot }, l.i))) })] }) })] }));
}
/** One timeline row; memoized, so a hover re-renders two rows, not the whole (up to 20K-row) table. */
const EventRow = memo(function EventRow({ l, t0, hot, focused, rowRef, onHover, }) {
    const cls = [l.error && 'oa-slog-has-err', focused && 'oa-slog-focused', hot && 'oa-slog-hot', l.k === 'start' && 'oa-slog-load'];
    return (_jsxs("tr", { ref: el => rowRef(l.i, el), onMouseEnter: () => onHover(l.i), className: cls.filter(Boolean).join(' '), children: [_jsx("td", { className: "oa-slog-num", children: _jsx("code", { children: fmtOffset(l.off) }) }), _jsx("td", { className: "oa-slog-num", children: _jsx("code", { className: "oa-slog-dim", children: fmtClock(l.t, t0) }) }), _jsxs("td", { className: "oa-slog-kind", children: [_jsx("span", { className: `oa-slog-dot oa-slog-lane-${l.lane}`, "aria-hidden": true }), " ", l.k] }), _jsx("td", { className: "oa-slog-ev", children: l.text }), _jsx("td", { className: "oa-slog-open", children: l.url && (_jsx("a", { href: l.url, target: "_blank", rel: "noreferrer", "aria-label": `open the view as it was: ${l.url}`, children: "open view \u2197" })) })] }));
});
const STRIP_W = 1000;
const LANE_H = 14;
/**
 * The session on a time axis: one lane per event family, errors red; hover
 * names the event (and highlights its table row), click jumps to it. `hot` is
 * the event hovered here or in the table: a full-height guide marks it.
 */
function Strip({ lines, hot, onHover, onPick, }) {
    const tks = useMemo(() => ticks(lines, STRIP_W), [lines]);
    const [hover, setHover] = useState(null);
    const marks = useMemo(() => tks.map(t => (_jsx("line", { x1: t.x, x2: t.x, y1: LANES.indexOf(t.lane) * LANE_H + 2, y2: (LANES.indexOf(t.lane) + 1) * LANE_H - 2, className: `oa-slog-tick oa-slog-lane-${t.lane}${t.error ? ' oa-slog-tick-err' : ''}`, vectorEffect: "non-scaling-stroke" }, t.i))), [tks]);
    const fig = useRef(null);
    const svg = useRef(null);
    const last = lines[lines.length - 1];
    if (!last)
        return null;
    const nearest = (clientX) => {
        const r = svg.current?.getBoundingClientRect();
        if (!r || !r.width)
            return null;
        const x = ((clientX - r.left) / r.width) * STRIP_W;
        let best = null;
        let d = Infinity;
        for (const t of tks) {
            const dd = Math.abs(t.x - x);
            if (dd < d) {
                d = dd;
                best = t.i;
            }
        }
        return d <= 8 ? best : null;
    };
    const h = LANES.length * LANE_H;
    const hovered = hover !== null ? lines[hover.i] : undefined;
    const hotTick = hot !== null ? tks[hot] : undefined;
    return (_jsxs("figure", { className: "oa-slog-strip", ref: fig, children: [_jsxs("svg", { ref: svg, viewBox: `0 0 ${STRIP_W} ${h}`, preserveAspectRatio: "none", role: "img", "aria-label": "Events over the session", onMouseMove: e => {
                    const i = nearest(e.clientX);
                    onHover(i);
                    const box = fig.current?.getBoundingClientRect();
                    setHover(i === null || !box ? null : { i, x: e.clientX - box.left, y: e.clientY - box.top });
                }, onMouseLeave: () => {
                    setHover(null);
                    onHover(null);
                }, onClick: e => {
                    const i = nearest(e.clientX);
                    if (i !== null)
                        onPick(i);
                }, children: [LANES.map((lane, li) => (_jsx("rect", { x: 0, y: li * LANE_H, width: STRIP_W, height: LANE_H, className: `oa-slog-lane-bg oa-slog-lane-${lane}` }, lane))), marks, hotTick && (_jsx("line", { x1: hotTick.x, x2: hotTick.x, y1: 0, y2: h, className: "oa-slog-guide", vectorEffect: "non-scaling-stroke" }))] }), _jsxs("figcaption", { children: [_jsx("span", { className: "oa-slog-lanes", children: LANES.map(l => (_jsxs("span", { children: [_jsx("span", { className: `oa-slog-dot oa-slog-lane-${l}`, "aria-hidden": true }), " ", l] }, l))) }), _jsxs("span", { className: "oa-slog-dim", children: [fmtOffset(0), " \u2192 ", fmtOffset(last.off)] })] }), hovered && hover && (_jsxs("div", { className: "oa-slog-tip", role: "tooltip", style: { left: hover.x, top: hover.y }, children: [_jsx("b", { children: fmtOffset(hovered.off) }), " ", hovered.k, ": ", hovered.text, _jsx("div", { className: "oa-slog-dim", children: "click to jump to it" })] }))] }));
}
