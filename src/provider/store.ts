/**
 * What an OIDC provider keeps between `/authorize` and `/token`: the
 * authorization code, by its hash, until it is exchanged once or expires.
 * It also remembers a spent code until its tokens expire, so that presenting the
 * code again can revoke them. Everything else is stateless (signed tokens) or the
 * gate's (sessions).
 */

/** One issued authorization code. */
export interface CodeRecord {
  /** `hashToken(code)`: the code itself is never stored. */
  codeHash: string
  clientId: string
  /** The exact `redirect_uri` of the authorization request; `/token` must repeat it. */
  redirectUri: string
  /** The PKCE S256 challenge, or `''` when a client with `requirePkce: false` sent none. */
  challenge: string
  nonce: string | null
  /** The verified address the code vouches for. */
  email: string
  /** The granted scopes, space-separated (`openid email profile`). */
  scope: string
  /** When that sign-in happened (epoch s), or null if unknown. */
  authTime: number | null
  /** Epoch s. */
  expiresAt: number
}

export interface ProviderStore {
  putCode(code: CodeRecord): Promise<void>
  /**
   * Remove and return the code, atomically: of two concurrent exchanges at
   * most one gets it. Expired codes return null.
   */
  takeCode(codeHash: string, nowS: number): Promise<CodeRecord | null>
  /** Remember an exchanged code until `expiresAt` (when its access token dies). */
  noteSpent(codeHash: string, expiresAt: number): Promise<void>
  /** The code was presented again: its access token stops working. A no-op for a code that isn't remembered. */
  revokeSpent(codeHash: string): Promise<void>
  isSpentRevoked(codeHash: string): Promise<boolean>
  /** Delete expired codes and spent records (bounded); returns how many went. */
  cleanup(nowS: number): Promise<number>
}

/** A process-local store, for tests and single-instance development. */
export function memoryProviderStore(): ProviderStore & { codes: Map<string, CodeRecord> } {
  const codes = new Map<string, CodeRecord>()
  const spent = new Map<string, { revoked: boolean; expiresAt: number }>()
  return {
    codes,
    async putCode(code) {
      codes.set(code.codeHash, { ...code })
    },
    async takeCode(codeHash, nowS) {
      const c = codes.get(codeHash)
      if (!c) return null
      codes.delete(codeHash)
      return c.expiresAt > nowS ? c : null
    },
    async noteSpent(codeHash, expiresAt) {
      spent.set(codeHash, { revoked: false, expiresAt })
    },
    async revokeSpent(codeHash) {
      const s = spent.get(codeHash)
      if (s) s.revoked = true
    },
    async isSpentRevoked(codeHash) {
      return spent.get(codeHash)?.revoked ?? false
    },
    async cleanup(nowS) {
      let n = 0
      for (const m of [codes, spent]) {
        for (const [k, c] of m) {
          if (c.expiresAt <= nowS) {
            m.delete(k)
            n++
          }
        }
      }
      return n
    },
  }
}
