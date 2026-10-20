import type {
  AuthResponses, GrantListInput, GrantUpdateInput, LogInput, MintInput, RotateInput,
} from '../core/http.js'

export interface AuthClientOptions {
  basePath?: string
  fetch?: typeof globalThis.fetch
}

export class AuthClientError extends Error {
  constructor(public readonly status: number, public readonly body: unknown) {
    super(`Auth request failed (${status})`)
    this.name = 'AuthClientError'
  }
}

function segment(id: string): string {
  if (!id || id === '.' || id === '..') throw new TypeError('Expected a nonempty, non-dot path segment')
  return encodeURIComponent(id)
}

export function createAuthClient({ basePath = '/api/auth', fetch = globalThis.fetch }: AuthClientOptions = {}) {
  const base = basePath.replace(/\/+$/, '')
  async function request<K extends keyof AuthResponses>(
    path: string,
    method = 'GET',
    input?: unknown,
  ): Promise<AuthResponses[K]> {
    const response = await fetch(`${base}${path}`, {
      method,
      credentials: 'same-origin',
      ...(input === undefined ? {} : {
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      }),
    })
    let body: unknown
    try {
      const text = await response.text()
      body = text || null
      if (text) {
        try { body = JSON.parse(text) } catch (error) {
          if (response.ok) throw error
        }
      }
    } catch (error) {
      if (response.ok) throw error
      throw new AuthClientError(response.status, undefined)
    }
    if (!response.ok) throw new AuthClientError(response.status, body)
    return body as AuthResponses[K]
  }
  const grantPath = (id: string) => `/grants/${segment(id)}`
  return {
    whoami: () => request<'whoami'>('/whoami'),
    logout: () => request<'logout'>('/logout', 'POST'),
    grants: {
      mint: (input: MintInput) => request<'mint'>('/grants', 'POST', input),
      list: ({ active }: GrantListInput = {}) => request<'list'>(`/grants${active ? '?active=1' : ''}`),
      update: (id: string, patch: GrantUpdateInput) => request<'update'>(grantPath(id), 'PATCH', patch),
      revoke: (id: string) => request<'revoke'>(`${grantPath(id)}/revoke`, 'POST'),
      disable: (id: string) => request<'disable'>(`${grantPath(id)}/disable`, 'POST'),
      enable: (id: string) => request<'enable'>(`${grantPath(id)}/enable`, 'POST'),
      rotate: (id: string, input: RotateInput = {}) => request<'rotate'>(`${grantPath(id)}/rotate`, 'POST', input),
      activity: (id: string) => request<'activity'>(`${grantPath(id)}/activity`),
    },
    log: ({ grant, limit }: LogInput = {}) => {
      const query = new URLSearchParams()
      if (grant !== undefined) query.set('grant', grant)
      if (limit !== undefined) query.set('limit', String(limit))
      return request<'log'>(`/log${query.size ? `?${query}` : ''}`)
    },
  }
}

export type AuthClient = ReturnType<typeof createAuthClient>

/** Construct locally: the token is never sent to a server by this helper. */
export function shareUrl(token: string, target?: string): string {
  if (target === undefined) {
    if (typeof location === 'undefined') throw new Error('shareUrl requires a target outside the browser')
    target = location.href
  }
  const url = new URL(target)
  url.searchParams.set('key', token)
  return url.href
}
