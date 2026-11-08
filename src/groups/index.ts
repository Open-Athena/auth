import type { EmailPolicy } from '../core/policy.js'

export interface GroupSnapshot {
  group: string
  members: string[]
  /** Successful listing time, epoch seconds; failures must not refresh this. */
  fetchedAt: number
}

export interface GroupSnapshotStore {
  get(group: string): Promise<GroupSnapshot | null>
  /** Atomically replace a snapshot unless a newer result is already stored. */
  put(snapshot: GroupSnapshot): Promise<void>
}

export const DEFAULT_GROUP_MAX_AGE_S = 15 * 60

/** Check on every authorization request, not only at OAuth sign-in. */
export function groupPolicy(
  store: Pick<GroupSnapshotStore, 'get'>,
  opts: { groups: Readonly<Record<string, readonly string[]>>; maxAgeS?: number; nowMs?: () => number },
): EmailPolicy {
  const maxAgeS = opts.maxAgeS ?? DEFAULT_GROUP_MAX_AGE_S
  if (!Number.isFinite(maxAgeS) || maxAgeS <= 0) throw new Error('groups: maxAgeS must be positive and finite')
  const groups = Object.entries(opts.groups).map(([group, scopes]) => [group.toLowerCase(), scopes] as const)
  return async email => {
    const nowS = Math.floor((opts.nowMs ?? Date.now)() / 1000)
    const snapshots = await Promise.all(groups.map(async ([group, scopes]) => ({ group, scopes, snapshot: await store.get(group) })))
    const allowed = new Set<string>()
    for (const { group, scopes, snapshot } of snapshots) {
      if (!snapshot || snapshot.group.toLowerCase() !== group || !Number.isFinite(snapshot.fetchedAt)) continue
      const age = nowS - snapshot.fetchedAt
      if (age < 0 || age >= maxAgeS) continue
      if (snapshot.members.some(member => member.toLowerCase() === email.toLowerCase())) {
        for (const scope of scopes) allowed.add(scope)
      }
    }
    return allowed.size ? [...allowed].sort() : null
  }
}
