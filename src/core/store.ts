/**
 * The store interface `core` depends on. Adapters (see `src/adapters/d1.ts`)
 * are pure row I/O: they map columns to `Grant` and back, and implement exactly
 * one piece of logic — the atomic `redeem` compare-and-swap, which has to live
 * in SQL to be race-free. Every other rule (expiry, revocation, scopes) stays
 * in core so there is one copy of it per rule, not one per backend.
 */
import type { Grant, NewGrant } from './types.js'

export interface GrantStore {
  byId(id: string): Promise<Grant | null>
  byTokenHash(tokenHash: string): Promise<Grant | null>
  insert(grant: Grant, tokenHash: string): Promise<void>
  /**
   * Atomically claim one redemption: increment `redeems` and stamp
   * `first_used_at`/`last_used_at`, but only if the grant is still unrevoked,
   * unexpired, and under `max_redeems`. Returns the updated grant, or null if
   * the guard failed. Must be a single statement — a read-then-write here would
   * let two concurrent opens both pass a `max_redeems: 1` check.
   */
  redeem(id: string, nowS: number): Promise<Grant | null>
  /**
   * Best-effort "last seen" stamp on a request that reused an existing session.
   * May skip the write if the grant was already touched within `minIntervalS`,
   * so a chatty SPA doesn't turn every fetch into a DB write.
   */
  touch(id: string, nowS: number, minIntervalS: number): Promise<void>
  /** Returns false if the grant was already revoked or does not exist. */
  revoke(id: string, nowS: number): Promise<boolean>
  list(opts?: { includeRevoked?: boolean }): Promise<Grant[]>
}

/** Convenience: what a store needs from `mintGrant` before it has an id/timestamps. */
export type GrantDraft = NewGrant
