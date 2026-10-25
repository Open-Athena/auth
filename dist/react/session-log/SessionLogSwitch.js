import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { lastDay } from '../../core/session-log-shape.js';
const day = (epochS) => new Date(epochS * 1000).toISOString().slice(0, 10);
/** The switch's one-line status. */
export function switchStatus(s) {
    const by = s.who && s.ts !== null ? ` Set by ${s.who} on ${day(s.ts)}.` : '';
    if (s.reason === 'not set up') {
        return 'Not set up on this deployment (no session_log tables): apply migrations/session-log/.';
    }
    if (s.enabled && s.indefinite)
        return `On (no end date).${by}`;
    if (s.enabled && s.until !== null)
        return `On through ${lastDay(s.until)} (UTC).${by}`;
    if (s.reason === 'expired' && s.until !== null)
        return `Off: ended after ${lastDay(s.until)} (UTC).${by}`;
    return `Off.${by}`;
}
/** The switch, as markup (pure: `SessionLogSwitch` wires it to the API). */
export function SessionLogSwitchView({ state, today, date, onDate, end, onEnd, onSet, busy, error, description, className = 'oa-slog-switch', }) {
    const setUp = state.reason !== 'not set up';
    const changed = state.enabled &&
        (end === 'indefinite' ? !state.indefinite : state.indefinite || (state.until !== null && date !== lastDay(state.until)));
    return (_jsxs("section", { className: className, children: [_jsx("h2", { children: "Session log" }), description, _jsx("p", { className: "oa-slog-status", children: switchStatus(state) }), setUp && (_jsxs("form", { onSubmit: e => {
                    e.preventDefault();
                    onSet(true);
                }, children: [_jsxs("label", { className: "oa-slog-toggle", children: [_jsx("input", { type: "checkbox", role: "switch", checked: state.enabled, disabled: busy, onChange: e => onSet(e.target.checked) }), ' ', "Logging"] }), _jsxs("span", { className: "oa-slog-ends", role: "radiogroup", "aria-label": "Ends", children: [_jsxs("label", { children: [_jsx("input", { type: "radio", name: "oa-slog-end", checked: end === 'dated', disabled: busy, onChange: () => onEnd('dated') }), ' ', "through", ' ', _jsx("input", { type: "date", value: date, min: today, max: lastDay(state.maxUntil), disabled: busy, onChange: e => {
                                            onDate(e.target.value);
                                            onEnd('dated');
                                        } }), ' ', "(UTC)"] }), _jsxs("label", { children: [_jsx("input", { type: "radio", name: "oa-slog-end", checked: end === 'indefinite', disabled: busy, onChange: () => onEnd('indefinite') }), ' ', "no end date"] })] }), changed && (_jsx("button", { type: "submit", disabled: busy, children: "Set end" }))] })), error && _jsx("p", { className: "oa-slog-err", children: error })] }));
}
async function call(endpoint, init) {
    const r = await fetch(`${endpoint}/switch`, { credentials: 'same-origin', cache: 'no-store', ...init });
    const body = (await r.json().catch(() => null));
    if (!r.ok)
        throw new Error(body?.error ?? `session-log switch: ${r.status}`);
    return body;
}
/**
 * The admin switch: on through a UTC date (default 7 days, at most 31), on
 * with no end date (until an admin turns it off), or off. A dated run ends by
 * itself after its date.
 */
export function SessionLogSwitch({ endpoint = '/api/session-log', description, className }) {
    const qc = useQueryClient();
    const key = ['oa-session-log', endpoint, 'switch'];
    const q = useQuery({ queryKey: key, queryFn: () => call(endpoint) });
    const [draft, setDraft] = useState(null);
    const [endDraft, setEndDraft] = useState(null);
    const set = useMutation({
        mutationFn: ({ enabled, until, end }) => call(endpoint, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(!enabled ? { enabled } : end === 'indefinite' ? { enabled, indefinite: true } : { enabled, until }),
        }),
        onSuccess: s => {
            qc.setQueryData(key, s);
            setDraft(null);
            setEndDraft(null);
        },
    });
    if (q.error) {
        return (_jsxs("section", { className: className ?? 'oa-slog-switch', children: [_jsx("h2", { children: "Session log" }), _jsx("p", { className: "oa-slog-err", children: q.error.message })] }));
    }
    if (!q.data)
        return null;
    const s = q.data;
    const date = draft ?? lastDay(s.enabled && !s.indefinite && s.until !== null ? s.until : s.defaultUntil);
    const end = endDraft ?? (s.indefinite ? 'indefinite' : 'dated');
    return (_jsx(SessionLogSwitchView, { state: s, today: new Date().toISOString().slice(0, 10), date: date, onDate: setDraft, end: end, onEnd: setEndDraft, onSet: enabled => set.mutate({ enabled, until: date, end }), busy: set.isPending, error: set.error?.message ?? null, description: description, className: className }));
}
