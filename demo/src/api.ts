import type { AccessRequest, Grant, GrantActivity, StoredEvent } from '@open-athena/auth'

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: 'include',
    ...init,
    headers: { ...(init?.body ? { 'content-type': 'application/json' } : {}), ...init?.headers },
  })
  const text = await res.text()
  const data = text ? JSON.parse(text) : null
  if (!res.ok) throw new ApiError(res.status, data?.error ?? res.statusText)
  return data as T
}

const post = <T,>(path: string, body?: unknown) =>
  call<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) })

export interface SandboxIdentity {
  id: string
  email: string
}

export const startSandbox = (id: string | null) => post<SandboxIdentity>('/api/sandbox', { id })

/** The recipient-side identity. One object, shared, so Home and Dashboard share one whoami cache entry. */
export const VIEW_SOURCE = { kind: 'app', endpoint: '/api/view/whoami' } as const

export interface MintInput {
  /** The memo: a note to whoever reads the admin table later, not the recipient's name. */
  name: string | null
  /** Optional recipient name — becomes the grant's `subject.name`. */
  subjectName?: string
  scopes: string[]
  maxRedeems: number | null
  expiresInS: number | null
}

/** What `/auth/google/client` says about this deployment. */
export interface GoogleClient {
  clientId: string | null
}

/** What the demo's email mount captured instead of (or as well as) sending. */
export interface Outbox {
  email: string
  sent: boolean
  code?: string
  link?: string
  at: number
}

export const api = {
  grants: () => call<{ grants: Grant[] }>('/api/admin/grants').then(r => r.grants),
  mint: (input: MintInput) => post<{ grant: Grant; token: string }>('/api/admin/grants', input),
  revoke: (id: string) => post<{ ok: boolean }>(`/api/admin/grants/${id}/revoke`),
  disable: (id: string) => post<{ ok: boolean }>(`/api/admin/grants/${id}/disable`),
  enable: (id: string) => post<{ ok: boolean }>(`/api/admin/grants/${id}/enable`),
  rotate: (id: string) => post<{ id: string; token: string }>(`/api/admin/grants/${id}/rotate`, { endSessions: false }),
  activity: (id: string) => call<GrantActivity>(`/api/admin/grants/${id}/activity`),
  log: (limit = 60) => call<{ events: StoredEvent[] }>(`/api/admin/log?limit=${limit}`).then(r => r.events),
  requests: () => call<{ requests: AccessRequest[] }>('/api/admin/requests?status=pending').then(r => r.requests),
  approve: (id: string) => post<{ token: string; grant: Grant }>(`/api/admin/requests/${id}/approve`),
  deny: (id: string) => post<{ request: AccessRequest }>(`/api/admin/requests/${id}/deny`),
  /** The gated fetch. Its only content is that it answered. */
  privateData: () => call<{ ok: true; at: number }>('/api/data/private'),
  googleClient: () => call<GoogleClient>('/auth/google/client'),
  /** `null` when this browser has nothing in the outbox (404). */
  outbox: () => call<Outbox>('/auth/email/outbox').catch(e => (e instanceof ApiError && e.status === 404 ? null : Promise.reject(e))),
}

export function ago(ts: number | null): string {
  if (ts === null) return 'never'
  const s = Math.max(0, Math.floor(Date.now() / 1000) - ts)
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}
