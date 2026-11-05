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
import { AuthClientError } from './api.js'
import type { AuthClient } from './api.js'
import { reportUnauthenticated } from './auth-events.js'
import type { Grant, GrantActivity, GrantUpdateInput, MintInput, RotateInput } from '../core/http.js'
import type { SessionLossReason } from '../core/denial.js'

export type GrantAction = 'update' | 'disable' | 'enable' | 'revoke' | 'rotate'

export interface GrantsFailure {
  action: GrantAction | 'mint' | 'refresh' | 'activity'
  /** Null for `mint` and `refresh`, which aren't about one link. */
  grantId: string | null
  /** The route's `detail` or `error` when it gave one, for display. */
  message: string
  error: unknown
}

export interface OneTimeToken {
  grantId: string
  token: string
  source: 'mint' | 'rotate'
}

export interface GrantsSnapshot {
  grants: readonly Grant[]
  /** True once a list has arrived: "no links yet" is only knowable then. */
  loaded: boolean
  /** A list request is in flight. */
  loading: boolean
  minting: boolean
  /** Per-link actions in flight, by grant id. */
  pending: Readonly<Record<string, GrantAction>>
  error: GrantsFailure | null
  token: OneTimeToken | null
  /** The last `activity(id)` result per link. */
  activities: Readonly<Record<string, GrantActivity>>
}

export interface GrantsControllerOptions {
  client: AuthClient
  /** Told about a 401, so `useWhoami` can show the wall. Default `<client.basePath>/whoami`. */
  whoamiEndpoint?: string
}

const failureMessage = (error: unknown): string => {
  if (error instanceof AuthClientError) {
    const body = error.body as { detail?: unknown; error?: unknown } | string | null | undefined
    if (typeof body === 'object' && body !== null) {
      if (typeof body.detail === 'string') return body.detail
      if (typeof body.error === 'string') return body.error
    }
  }
  return error instanceof Error ? error.message : String(error)
}

export function createGrantsController({ client, whoamiEndpoint = `${client.basePath}/whoami` }: GrantsControllerOptions) {
  let snapshot: GrantsSnapshot = {
    grants: [],
    loaded: false,
    loading: false,
    minting: false,
    pending: {},
    error: null,
    token: null,
    activities: {},
  }
  const listeners = new Set<() => void>()
  const set = (patch: Partial<GrantsSnapshot>) => {
    snapshot = { ...snapshot, ...patch }
    for (const listener of listeners) listener()
  }

  /**
   * Bumped by every list request and every finished change. A list response is
   * applied only if its generation is still current, so one that left before a
   * revoke can't bring the revoked link's old state back. Each finished change
   * starts a fresh list, so a dropped response always has a successor.
   */
  let generation = 0
  let listsInFlight = 0
  const activityRequests = new Map<string, number>()

  const failure = (action: GrantsFailure['action'], grantId: string | null, error: unknown): GrantsFailure => {
    if (error instanceof AuthClientError && error.status === 401) {
      const reason = (error.body as { reason?: SessionLossReason } | null)?.reason ?? null
      reportUnauthenticated(reason, { endpoint: whoamiEndpoint })
    }
    return { action, grantId, message: failureMessage(error), error }
  }

  async function refresh(): Promise<void> {
    const mine = ++generation
    listsInFlight++
    if (!snapshot.loading) set({ loading: true })
    let patch: Partial<GrantsSnapshot> = {}
    try {
      const { grants } = await client.grants.list()
      if (mine === generation) {
        patch = { grants, loaded: true }
        // A list that worked answers an earlier list's failure, not a change's.
        if (snapshot.error?.action === 'refresh') patch.error = null
      }
    } catch (error) {
      if (mine === generation) patch = { error: failure('refresh', null, error) }
    }
    listsInFlight--
    set({ ...patch, loading: listsInFlight > 0 })
  }

  async function mint(input: MintInput): Promise<Grant | null> {
    if (snapshot.minting) return null
    set({ minting: true, error: null })
    let minted: Grant | null = null
    try {
      const { grant, token } = await client.grants.mint(input)
      generation++
      minted = grant
      set({
        minting: false,
        grants: [grant, ...snapshot.grants.filter(g => g.id !== grant.id)],
        token: { grantId: grant.id, token, source: 'mint' },
      })
    } catch (error) {
      generation++
      set({ minting: false, error: failure('mint', null, error) })
    }
    void refresh()
    return minted
  }

  /** One change to one link: refused while another is in flight on it. False if it failed. */
  async function change(
    id: string,
    action: GrantAction,
    run: () => Promise<Partial<GrantsSnapshot>>,
  ): Promise<boolean> {
    if (snapshot.pending[id]) return false
    set({ pending: { ...snapshot.pending, [id]: action }, error: null })
    const settled = (patch: Partial<GrantsSnapshot>) => {
      const { [id]: _done, ...pending } = snapshot.pending
      generation++
      set({ ...patch, pending })
    }
    let ok = true
    try {
      settled(await run())
    } catch (error) {
      ok = false
      settled({ error: failure(action, id, error) })
    }
    // A failure refreshes too: a request that died in transit may still have landed.
    void refresh()
    return ok
  }

  const update = (id: string, patch: GrantUpdateInput) =>
    change(id, 'update', async () => {
      const { grant } = await client.grants.update(id, patch)
      return { grants: snapshot.grants.map(g => (g.id === id ? grant : g)) }
    })

  const disable = (id: string) => change(id, 'disable', async () => (await client.grants.disable(id), {}))
  const enable = (id: string) => change(id, 'enable', async () => (await client.grants.enable(id), {}))

  const revoke = (id: string) =>
    change(id, 'revoke', async () => {
      await client.grants.revoke(id)
      // That link is dead: showing it as something to copy would be a lie.
      return snapshot.token?.grantId === id ? { token: null } : {}
    })

  const rotate = (id: string, input: RotateInput = {}) =>
    change(id, 'rotate', async () => {
      const { token } = await client.grants.rotate(id, input)
      return { token: { grantId: id, token, source: 'rotate' as const } }
    })

  async function activity(id: string): Promise<void> {
    const mine = (activityRequests.get(id) ?? 0) + 1
    activityRequests.set(id, mine)
    try {
      const result = await client.grants.activity(id)
      if (activityRequests.get(id) !== mine) return
      const stale = snapshot.error?.action === 'activity' && snapshot.error.grantId === id
      set({ activities: { ...snapshot.activities, [id]: result }, ...(stale ? { error: null } : {}) })
    } catch (error) {
      // Secondary to whatever else went wrong: never displace a change's failure.
      if (activityRequests.get(id) === mine && !snapshot.error) set({ error: failure('activity', id, error) })
    }
  }

  return {
    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    getSnapshot: (): GrantsSnapshot => snapshot,
    refresh,
    /** The new link, or null if it failed (see `error`). Its token is in the snapshot, not here. */
    mint,
    update,
    disable,
    enable,
    revoke,
    rotate,
    activity,
    dismissToken(): void {
      if (snapshot.token) set({ token: null })
    },
  }
}

export type GrantsController = ReturnType<typeof createGrantsController>
