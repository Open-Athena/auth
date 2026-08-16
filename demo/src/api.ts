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

export interface MintInput {
  name: string
  note?: string
  scopes: string[]
  maxRedeems: number | null
  expiresInS: number | null
}

export const api = {
  grants: () => call<{ grants: Grant[] }>('/api/admin/grants?all=1').then(r => r.grants),
  mint: (input: MintInput) => post<{ grant: Grant; token: string }>('/api/admin/grants', input),
  revoke: (id: string) => post<{ ok: boolean }>(`/api/admin/grants/${id}/revoke`),
  activity: (id: string) => call<GrantActivity>(`/api/admin/grants/${id}/activity`),
  log: (limit = 60) => call<{ events: StoredEvent[] }>(`/api/admin/log?limit=${limit}`).then(r => r.events),
  requests: () => call<{ requests: AccessRequest[] }>('/api/admin/requests?status=pending').then(r => r.requests),
  approve: (id: string) => post<{ token: string; grant: Grant }>(`/api/admin/requests/${id}/approve`),
  deny: (id: string) => post<{ request: AccessRequest }>(`/api/admin/requests/${id}/deny`),
  summary: () => call<Summary>('/api/data/summary'),
}

export interface Summary {
  title: string
  updated: string
  totals: { committed: number; received: number; pledged: number }
  funds: { name: string; committed: number; received: number }[]
  donors: { name: string; amount: number; status: string }[]
}

export const money = (n: number): string => `$${(n / 1000).toLocaleString('en-US', { maximumFractionDigits: 0 })}k`

export function ago(ts: number | null): string {
  if (ts === null) return 'never'
  const s = Math.max(0, Math.floor(Date.now() / 1000) - ts)
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}
