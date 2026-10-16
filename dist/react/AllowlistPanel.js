import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useCallback, useEffect, useState } from 'react';
const DEFAULTS = {
    email: 'Email to allow',
    add: 'Add',
    adding: 'Adding…',
    remove: 'Remove',
    empty: 'No one is on the allowlist yet.',
    synced: 'synced',
    manual: 'manual',
    sync: 'Sync now',
    syncing: 'Syncing…',
    syncDone: 'Synced',
};
const isSyncSummary = (v) => Array.isArray(v) && v.every(r => r && typeof r.group === 'string' && typeof r.count === 'number');
/**
 * Manage the SSO allowlist: list allowed emails, add one, remove one. Unstyled
 * like the rest of `react/` — every visible string and class is a prop.
 *
 * A row's `source` distinguishes a hand-added address (`manual`) from one a
 * directory sync owns (`sync:…`); both are removable here, but a sync will
 * re-add the ones it manages on its next run, so removing a synced member is
 * only durable if you also take them out of the upstream group.
 */
export function AllowlistPanel({ endpoint = '/api/auth/allowed', defaultScopes = [], onChanged, sync = false, classNames = {}, labels = {}, }) {
    const t = { ...DEFAULTS, ...labels };
    const [rows, setRows] = useState([]);
    const [email, setEmail] = useState('');
    const [state, setState] = useState('loading');
    const [error, setError] = useState(null);
    const [notice, setNotice] = useState(null);
    const load = useCallback(async () => {
        try {
            const res = await fetch(endpoint, { credentials: 'include' });
            if (!res.ok)
                throw new Error(`${res.status}`);
            const body = (await res.json());
            setRows(body.allowed);
            setState('idle');
        }
        catch {
            setState('error');
            setError('Could not load the allowlist.');
        }
    }, [endpoint]);
    useEffect(() => {
        void load();
    }, [load]);
    async function add(e) {
        e.preventDefault();
        const value = email.trim();
        if (!value || state === 'saving')
            return;
        setState('saving');
        setError(null);
        try {
            const res = await fetch(endpoint, {
                method: 'POST',
                credentials: 'include',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ email: value, scopes: [...defaultScopes] }),
            });
            if (!res.ok) {
                const body = (await res.json().catch(() => ({})));
                throw new Error(body.error ?? `${res.status}`);
            }
            setEmail('');
            await load();
            onChanged?.();
        }
        catch (err) {
            setState('error');
            setError(err instanceof Error ? err.message : 'Could not add that address.');
        }
    }
    async function runSync() {
        if (state === 'saving')
            return;
        setState('saving');
        setError(null);
        setNotice(null);
        try {
            const res = await fetch(`${endpoint}/sync`, { method: 'POST', credentials: 'include' });
            const body = (await res.json().catch(() => ({})));
            if (!res.ok || !body.ok)
                throw new Error(body.error ?? `${res.status}`);
            const summary = isSyncSummary(body.result) ? `: ${body.result.map(r => `${r.group} (${r.count})`).join(', ')}` : '';
            setNotice(`${t.syncDone}${summary}`);
            await load();
            onChanged?.();
        }
        catch (err) {
            setState('error');
            setError(err instanceof Error ? err.message : 'Could not sync.');
        }
    }
    async function remove(target) {
        setState('saving');
        setError(null);
        try {
            const res = await fetch(`${endpoint}/${encodeURIComponent(target)}`, { method: 'DELETE', credentials: 'include' });
            if (!res.ok)
                throw new Error(`${res.status}`);
            await load();
            onChanged?.();
        }
        catch {
            setState('error');
            setError('Could not remove that address.');
        }
    }
    return (_jsxs("div", { className: classNames.root, children: [_jsxs("form", { className: classNames.form, onSubmit: add, children: [_jsx("input", { className: classNames.input, type: "email", value: email, placeholder: t.email, "aria-label": t.email, onChange: e => setEmail(e.target.value) }), _jsx("button", { className: classNames.button, type: "submit", disabled: state === 'saving' || !email.trim(), children: state === 'saving' ? t.adding : t.add })] }), sync && (_jsx("button", { className: classNames.sync, type: "button", onClick: runSync, disabled: state === 'saving', children: state === 'saving' ? t.syncing : t.sync })), error && (_jsx("p", { className: classNames.message, role: "alert", children: error })), notice && (_jsx("p", { className: classNames.message, role: "status", children: notice })), rows.length === 0 && state !== 'loading' ? (_jsx("p", { className: classNames.empty, children: t.empty })) : (_jsx("table", { className: classNames.table, children: _jsx("tbody", { children: rows.map(r => (_jsxs("tr", { className: classNames.row, children: [_jsx("td", { className: classNames.cell, children: r.email }), _jsx("td", { className: classNames.cell, children: _jsx("span", { className: classNames.source, children: r.source === 'manual' ? t.manual : t.synced }) }), _jsx("td", { className: classNames.cell, children: _jsx("button", { className: classNames.remove, type: "button", onClick: () => remove(r.email), disabled: state === 'saving', "aria-label": `${t.remove} ${r.email}`, children: t.remove }) })] }, r.email))) }) }))] }));
}
