export const SELECTION_HEADER = 'X-OA-Selection-Context';
/** A 409 meaning "the browser's accounts changed since this page looked": refresh, then let the person retry. */
export class SelectionConflictError extends Error {
    constructor() {
        super('Your accounts changed in another tab; review and try again.');
        this.name = 'SelectionConflictError';
    }
}
/** Any other refusal, with the server's error code (`retained-login-capacity`, `incoming-unavailable`, …). */
export class AccountsError extends Error {
    status;
    code;
    constructor(status, code) {
        super(code ?? `accounts request failed (${status})`);
        this.status = status;
        this.code = code;
        this.name = 'AccountsError';
    }
}
const channelName = (basePath) => `oa-auth:${basePath}`;
/** Tell this browser's other tabs that the selection changed. A no-op where `BroadcastChannel` doesn't exist. */
export function announceSelectionChange(basePath = '/api/auth') {
    if (typeof BroadcastChannel === 'undefined')
        return;
    const ch = new BroadcastChannel(channelName(basePath));
    ch.postMessage({ type: 'selection' });
    ch.close();
}
/** Run `listener` when another tab changes this browser's selection. Returns the unsubscribe. */
export function onSelectionChange(listener, basePath = '/api/auth') {
    if (typeof BroadcastChannel === 'undefined')
        return () => { };
    const ch = new BroadcastChannel(channelName(basePath));
    ch.onmessage = e => {
        if (e.data?.type === 'selection')
            listener();
    };
    return () => ch.close();
}
export function createAccountsClient({ basePath = '/api/auth', fetch = globalThis.fetch } = {}) {
    const base = basePath.replace(/\/+$/, '');
    async function call(path, init = {}) {
        return fetch(`${base}${path}`, { credentials: 'same-origin', cache: 'no-store', ...init });
    }
    async function read(res) {
        const text = await res.text();
        try {
            return text ? JSON.parse(text) : null;
        }
        catch {
            return null;
        }
    }
    async function mutate(path, selection, input = {}, announce = true) {
        const res = await call(path, {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...(selection ? { [SELECTION_HEADER]: selection } : {}) },
            body: JSON.stringify(input),
        });
        const body = await read(res);
        if (res.status === 409 && body?.error === 'selection_context_conflict') {
            throw new SelectionConflictError();
        }
        if (!res.ok) {
            const code = body?.error;
            throw new AccountsError(res.status, typeof code === 'string' ? code : null);
        }
        if (announce)
            announceSelectionChange(basePath);
        return body;
    }
    return {
        /** This browser's accounts, or null when it holds none (or the gate isn't in retained mode). */
        async list() {
            const res = await call('/accounts');
            if (res.status === 404 || res.status === 401)
                return null;
            if (!res.ok)
                throw new AccountsError(res.status, null);
            return (await read(res));
        },
        /** Switch to one of this browser's accounts (`null`: to none, keeping them all). */
        select: (id, selection) => mutate('/accounts/select', selection, { id }),
        /** Take an account off this browser (not the link, not other browsers). */
        remove: (id, selection) => mutate('/accounts/remove', selection, { id }),
        /** Use an incoming share link that was held while another account was active. */
        acceptIncoming: (id, selection) => mutate('/accounts/incoming', selection, { id }),
        /** Sign out of the active account only; the browser keeps the others. */
        logout: (selection) => mutate('/logout', selection),
        /** Sign this browser out of every account. */
        logoutAll: () => mutate('/logout-all', null),
    };
}
