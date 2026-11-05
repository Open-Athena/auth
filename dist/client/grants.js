/**
 * Share-link administration, framework-free: the list, what's in flight, the
 * last failure, and the one-time token. Bind it with `subscribe`/`getSnapshot`
 * (`useGrants` in `/react`; Vue and Svelte stores wrap the same two calls).
 *
 * The raw token exists only in this object's memory, from the response that
 * minted or rotated it until `dismissToken()`, a newer token, or revoking that
 * link. It isn't persisted or logged, and the actions don't return it: render it
 * from the snapshot, once, for the admin to copy.
 */
import { AuthClientError } from './api.js';
import { reportUnauthenticated } from './auth-events.js';
const failureMessage = (error) => {
    if (error instanceof AuthClientError) {
        const body = error.body;
        if (typeof body === 'object' && body !== null) {
            if (typeof body.detail === 'string')
                return body.detail;
            if (typeof body.error === 'string')
                return body.error;
        }
    }
    return error instanceof Error ? error.message : String(error);
};
export function createGrantsController({ client, whoamiEndpoint = `${client.basePath}/whoami` }) {
    let snapshot = {
        grants: [],
        loaded: false,
        loading: false,
        minting: false,
        pending: {},
        error: null,
        token: null,
        activities: {},
    };
    const listeners = new Set();
    const set = (patch) => {
        snapshot = { ...snapshot, ...patch };
        for (const listener of listeners)
            listener();
    };
    /**
     * Bumped by every list request and every finished change. A list response is
     * applied only if its generation is still current, so one that left before a
     * revoke can't bring the revoked link's old state back. Each finished change
     * starts a fresh list, so a dropped response always has a successor.
     */
    let generation = 0;
    let listsInFlight = 0;
    const activityRequests = new Map();
    const failure = (action, grantId, error) => {
        if (error instanceof AuthClientError && error.status === 401) {
            const reason = error.body?.reason ?? null;
            reportUnauthenticated(reason, { endpoint: whoamiEndpoint });
        }
        return { action, grantId, message: failureMessage(error), error };
    };
    async function refresh() {
        const mine = ++generation;
        listsInFlight++;
        if (!snapshot.loading)
            set({ loading: true });
        let patch = {};
        try {
            const { grants } = await client.grants.list();
            if (mine === generation) {
                patch = { grants, loaded: true };
                // A list that worked answers an earlier list's failure, not a change's.
                if (snapshot.error?.action === 'refresh')
                    patch.error = null;
            }
        }
        catch (error) {
            if (mine === generation)
                patch = { error: failure('refresh', null, error) };
        }
        listsInFlight--;
        set({ ...patch, loading: listsInFlight > 0 });
    }
    async function mint(input) {
        if (snapshot.minting)
            return null;
        set({ minting: true, error: null });
        let minted = null;
        try {
            const { grant, token } = await client.grants.mint(input);
            generation++;
            minted = grant;
            set({
                minting: false,
                grants: [grant, ...snapshot.grants.filter(g => g.id !== grant.id)],
                token: { grantId: grant.id, token, source: 'mint' },
            });
        }
        catch (error) {
            generation++;
            set({ minting: false, error: failure('mint', null, error) });
        }
        void refresh();
        return minted;
    }
    /** One change to one link: refused while another is in flight on it. False if it failed. */
    async function change(id, action, run) {
        if (snapshot.pending[id])
            return false;
        set({ pending: { ...snapshot.pending, [id]: action }, error: null });
        const settled = (patch) => {
            const { [id]: _done, ...pending } = snapshot.pending;
            generation++;
            set({ ...patch, pending });
        };
        let ok = true;
        try {
            settled(await run());
        }
        catch (error) {
            ok = false;
            settled({ error: failure(action, id, error) });
        }
        // A failure refreshes too: a request that died in transit may still have landed.
        void refresh();
        return ok;
    }
    const update = (id, patch) => change(id, 'update', async () => {
        const { grant } = await client.grants.update(id, patch);
        return { grants: snapshot.grants.map(g => (g.id === id ? grant : g)) };
    });
    const disable = (id) => change(id, 'disable', async () => (await client.grants.disable(id), {}));
    const enable = (id) => change(id, 'enable', async () => (await client.grants.enable(id), {}));
    const revoke = (id) => change(id, 'revoke', async () => {
        await client.grants.revoke(id);
        // That link is dead: showing it as something to copy would be a lie.
        return snapshot.token?.grantId === id ? { token: null } : {};
    });
    const rotate = (id, input = {}) => change(id, 'rotate', async () => {
        const { token } = await client.grants.rotate(id, input);
        return { token: { grantId: id, token, source: 'rotate' } };
    });
    async function activity(id) {
        const mine = (activityRequests.get(id) ?? 0) + 1;
        activityRequests.set(id, mine);
        try {
            const result = await client.grants.activity(id);
            if (activityRequests.get(id) !== mine)
                return;
            const stale = snapshot.error?.action === 'activity' && snapshot.error.grantId === id;
            set({ activities: { ...snapshot.activities, [id]: result }, ...(stale ? { error: null } : {}) });
        }
        catch (error) {
            // Secondary to whatever else went wrong: never displace a change's failure.
            if (activityRequests.get(id) === mine && !snapshot.error)
                set({ error: failure('activity', id, error) });
        }
    }
    return {
        subscribe(listener) {
            listeners.add(listener);
            return () => { listeners.delete(listener); };
        },
        getSnapshot: () => snapshot,
        refresh,
        /** The new link, or null if it failed (see `error`). Its token is in the snapshot, not here. */
        mint,
        update,
        disable,
        enable,
        revoke,
        rotate,
        activity,
        dismissToken() {
            if (snapshot.token)
                set({ token: null });
        },
    };
}
