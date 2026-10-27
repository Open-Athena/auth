/**
 * What an OIDC provider keeps between `/authorize` and `/token`: the
 * authorization code, by its hash, until it is exchanged once or expires.
 * Everything else is stateless (signed tokens) or the gate's (sessions).
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
  /** Delete expired codes (bounded); returns how many went. */
  cleanup(nowS: number): Promise<number>
}

/** A process-local store, for tests and single-instance development. */
export function memoryProviderStore(): ProviderStore & { codes: Map<string, CodeRecord> } {
  const codes = new Map<string, CodeRecord>()
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
    async cleanup(nowS) {
      let n = 0
      for (const [k, c] of codes) {
        if (c.expiresAt <= nowS) {
          codes.delete(k)
          n++
        }
      }
      return n
    },
  }
}
