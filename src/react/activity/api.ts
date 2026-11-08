import type { ActivityBurst, ActivityKind } from '../../activity/types.js'

export interface ActivityPage { bursts: ActivityBurst[] }
export interface ActivityKindsPage { kinds: Record<string, ActivityKind> }

export const activityEndpoint = (endpoint: string) => endpoint.replace(/\/$/, '')

export async function activityJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, credentials: 'same-origin', cache: 'no-store' })
  let body: unknown
  try { body = await response.json() }
  catch { throw new Error(`Activity request failed (HTTP ${response.status}): invalid response`) }
  if (!response.ok) {
    const error = body && typeof body === 'object' && 'error' in body ? body.error : null
    throw new Error(typeof error === 'string' ? error : `Activity request failed (HTTP ${response.status})`)
  }
  return body as T
}

export const activityKeys = (endpoint: string) => ['oa-activity', activityEndpoint(endpoint)] as const
