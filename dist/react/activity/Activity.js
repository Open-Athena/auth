import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { activityEndpoint, activityJson, activityKeys } from './api.js';
const modes = ['off', 'count', 'line'];
const countLabel = (counts) => Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)).map(([kind, count]) => `${kind}: ${count}`).join(', ') || 'None';
const clock = (ts) => new Date(ts * 1000).toLocaleString();
const Time = ({ ts }) => _jsx("time", { dateTime: new Date(ts * 1000).toISOString(), children: clock(ts) });
function BurstDetail({ endpoint, id }) {
    const query = useQuery({
        queryKey: [...activityKeys(endpoint), 'burst', id],
        queryFn: ({ signal }) => activityJson(`${endpoint}/${encodeURIComponent(id)}`, { signal }),
        retry: false, gcTime: 0,
    });
    return _jsxs("section", { className: "oa-activity-detail", "aria-label": "Burst detail", "aria-busy": query.isFetching, children: [query.isPending && _jsx("p", { role: "status", children: "Loading detail..." }), query.error && _jsx("p", { role: "alert", children: query.error.message }), query.data && _jsxs(_Fragment, { children: [_jsx("h3", { children: query.data.burst.actor.name }), _jsxs("p", { children: [query.data.burst.actor.id, " / ", query.data.burst.actor.via] }), _jsx("p", { children: query.data.burst.origin }), _jsxs("p", { children: ["Recorded: ", countLabel(query.data.burst.counts)] }), _jsxs("p", { children: ["Notifications: ", countLabel(query.data.burst.notifyCounts)] }), query.data.burst.lines.length === 0 ? _jsx("p", { children: "No recorded lines." }) : _jsx("ol", { className: "oa-activity-lines", children: query.data.burst.lines.map(line => _jsxs("li", { children: [_jsx(Time, { ts: line.ts }), " ", _jsx("strong", { children: line.kind }), " ", _jsx("span", { children: line.line ?? line.path ?? 'No detail' }), line.path && line.line !== line.path && _jsx("code", { children: line.path }), line.sessionId && _jsxs("span", { children: ["Session: ", line.sessionId] })] }, line.id)) }), query.data.burst.omittedLines > 0 && _jsxs("p", { children: [query.data.burst.omittedLines, " older lines omitted."] })] })] });
}
export function ActivityList({ endpoint = '/api/activity', className = '' }) {
    const base = activityEndpoint(endpoint);
    const [actorId, setActorId] = useState('');
    const [origin, setOrigin] = useState('');
    const [since, setSince] = useState('');
    const [limit, setLimit] = useState('100');
    const [search, setSearch] = useState('limit=100');
    const [selected, setSelected] = useState(null);
    const detailId = useId();
    const query = useQuery({
        queryKey: [...activityKeys(base), 'bursts', search],
        queryFn: ({ signal }) => activityJson(`${base}?${search}`, { signal }),
        retry: false, gcTime: 0,
    });
    function filter(event) {
        event.preventDefault();
        const params = new URLSearchParams();
        if (actorId.trim())
            params.set('actorId', actorId.trim());
        if (origin.trim())
            params.set('origin', origin.trim());
        if (since)
            params.set('since', String(Math.floor(new Date(since).getTime() / 1000)));
        params.set('limit', limit);
        setSelected(null);
        setSearch(params.toString());
    }
    return _jsxs("section", { className: `oa-activity ${className}`, "aria-label": "Activity bursts", children: [_jsx("h2", { children: "Activity" }), _jsxs("form", { className: "oa-activity-filters", onSubmit: filter, children: [_jsxs("label", { children: ["Actor ID", _jsx("input", { type: "search", value: actorId, maxLength: 512, onChange: event => setActorId(event.target.value) })] }), _jsxs("label", { children: ["Origin", _jsx("input", { type: "search", value: origin, maxLength: 512, onChange: event => setOrigin(event.target.value) })] }), _jsxs("label", { children: ["Active since", _jsx("input", { type: "datetime-local", value: since, onChange: event => setSince(event.target.value) })] }), _jsxs("label", { children: ["Limit", _jsx("select", { value: limit, onChange: event => setLimit(event.target.value), children: [25, 50, 100, 250, 500].map(value => _jsx("option", { value: value, children: value }, value)) })] }), _jsx("button", { type: "submit", children: "Apply filters" }), _jsx("button", { type: "button", disabled: query.isFetching, onClick: () => void query.refetch(), children: "Refresh" })] }), _jsxs("div", { "aria-busy": query.isFetching, children: [query.isFetching && _jsx("p", { role: "status", children: "Loading activity..." }), query.error && _jsx("p", { role: "alert", children: query.error.message }), query.data && !query.error && _jsx(_Fragment, { children: query.data.bursts.length === 0 ? _jsx("p", { role: "status", children: "No activity matches these filters." }) : _jsx("div", { className: "oa-activity-scroll", children: _jsxs("table", { children: [_jsx("caption", { children: "Recent activity bursts" }), _jsx("thead", { children: _jsx("tr", { children: ['Actor', 'Origin', 'First seen', 'Last seen', 'Recorded', 'Detail'].map(label => _jsx("th", { scope: "col", children: label }, label)) }) }), _jsx("tbody", { children: query.data.bursts.map(burst => _jsxs("tr", { children: [_jsxs("th", { scope: "row", children: [_jsx("span", { children: burst.actor.name }), _jsxs("small", { children: [burst.actor.id, " / ", burst.actor.via] })] }), _jsx("td", { children: burst.origin }), _jsx("td", { children: _jsx(Time, { ts: burst.firstTs }) }), _jsx("td", { children: _jsx(Time, { ts: burst.lastTs }) }), _jsx("td", { children: countLabel(burst.counts) }), _jsx("td", { children: _jsx("button", { type: "button", "aria-label": `${selected === burst.id ? 'Close' : 'View'} burst for ${burst.actor.name}`, "aria-expanded": selected === burst.id, "aria-controls": selected === burst.id ? detailId : undefined, onClick: () => setSelected(selected === burst.id ? null : burst.id), children: selected === burst.id ? 'Close' : 'View' }) })] }, burst.id)) })] }) }) })] }), selected && _jsx("div", { id: detailId, children: _jsx(BurstDetail, { endpoint: base, id: selected }, `${base}/${selected}`) })] });
}
function KindRow({ endpoint, kind, policy }) {
    const client = useQueryClient();
    const [draft, setDraft] = useState(policy);
    const mutation = useMutation({
        mutationFn: () => activityJson(`${endpoint}/kinds/${encodeURIComponent(kind)}`, {
            method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(draft),
        }),
        onSuccess: data => { client.setQueryData([...activityKeys(endpoint), 'kinds'], data); },
    });
    const changed = draft.record !== policy.record || draft.notify !== policy.notify;
    return _jsxs("tr", { children: [_jsx("th", { scope: "row", children: kind }), _jsx("td", { children: _jsx("select", { "aria-label": `Record ${kind}`, value: draft.record, disabled: mutation.isPending, onChange: event => {
                        const record = event.target.value;
                        setDraft({ record, notify: modes.indexOf(draft.notify) > modes.indexOf(record) ? record : draft.notify });
                        mutation.reset();
                    }, children: modes.map(mode => _jsx("option", { value: mode, children: mode }, mode)) }) }), _jsx("td", { children: _jsx("select", { "aria-label": `Notify ${kind}`, value: draft.notify, disabled: mutation.isPending, onChange: event => {
                        setDraft({ ...draft, notify: event.target.value });
                        mutation.reset();
                    }, children: modes.map(mode => _jsx("option", { value: mode, disabled: modes.indexOf(mode) > modes.indexOf(draft.record), children: mode }, mode)) }) }), _jsxs("td", { children: [_jsx("button", { type: "button", "aria-label": `Save ${kind} policy`, disabled: !changed || mutation.isPending, onClick: () => mutation.mutate(), children: mutation.isPending ? 'Saving...' : 'Save' }), mutation.error && _jsx("p", { role: "alert", children: mutation.error.message })] })] });
}
export function ActivityKindSettings({ endpoint = '/api/activity', className = '' }) {
    const base = activityEndpoint(endpoint);
    const query = useQuery({
        queryKey: [...activityKeys(base), 'kinds'],
        queryFn: ({ signal }) => activityJson(`${base}/kinds`, { signal }),
        retry: false, gcTime: 0,
    });
    return _jsxs("section", { className: `oa-activity ${className}`, "aria-label": "Activity kind settings", "aria-busy": query.isFetching, children: [_jsx("h2", { children: "Kind settings" }), query.isPending && _jsx("p", { role: "status", children: "Loading kind settings..." }), query.error && _jsxs(_Fragment, { children: [_jsx("p", { role: "alert", children: query.error.message }), _jsx("button", { type: "button", disabled: query.isFetching, onClick: () => void query.refetch(), children: "Retry settings" })] }), query.data && !query.error && _jsx(_Fragment, { children: Object.keys(query.data.kinds).length === 0 ? _jsx("p", { role: "status", children: "No activity kinds configured." }) : _jsx("div", { className: "oa-activity-scroll", children: _jsxs("table", { children: [_jsx("caption", { children: "Recording and notification policies" }), _jsx("thead", { children: _jsx("tr", { children: ['Kind', 'Record', 'Notify', 'Save'].map(label => _jsx("th", { scope: "col", children: label }, label)) }) }), _jsx("tbody", { children: Object.entries(query.data.kinds).sort(([a], [b]) => a.localeCompare(b)).map(([kind, policy]) => _jsx(KindRow, { endpoint: base, kind: kind, policy: policy }, `${base}/${kind}/${policy.record}/${policy.notify}`)) })] }) }) })] });
}
export function ActivityAdmin(props) {
    return _jsxs("div", { className: "oa-activity-admin", children: [_jsx(ActivityList, { ...props }), _jsx(ActivityKindSettings, { ...props })] });
}
