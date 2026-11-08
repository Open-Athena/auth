import type { ActivityFeed } from './index.js'
import type { ActivityFilter, ActivityStore } from './types.js'
import { activityText } from './shape.js'

export interface ActivityRoutesOptions {
  feed: ActivityFeed
  store: Pick<ActivityStore, 'list' | 'get'>
  basePath?: string
  /** Mandatory application authorization; refusing must return 401 or 403. */
  requireAdmin: (request: Request) => Promise<{ who: string } | Response>
}

const json = (value: unknown, status = 200) => Response.json(value, {
  status, headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
})

/** Count bytes as they arrive, rather than buffering an unbounded request first. */
async function readPolicy(request: Request): Promise<unknown | Response> {
  const length = request.headers.get('content-length')
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > 4096)) return json({ error: 'body too large' }, 413)
  const reader = request.body?.getReader()
  if (!reader) return json({ error: 'invalid JSON' }, 400)
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > 4096) {
        void reader.cancel().catch(() => {})
        return json({ error: 'body too large' }, 413)
      }
      chunks.push(value)
    }
  } catch {
    return json({ error: 'invalid body' }, 400)
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)) as unknown }
  catch { return json({ error: 'invalid JSON' }, 400) }
}

/** Staff reads/settings only. There is intentionally no public event-ingestion route. */
export function activityRoutes({ feed, store, requireAdmin, basePath = '/api/activity' }: ActivityRoutesOptions) {
  if (typeof requireAdmin !== 'function') throw new TypeError('activity: requireAdmin is required')
  const base = basePath.replace(/\/$/, '')
  if (!base.startsWith('/') || base === '' || base.includes('?') || base.includes('#')) throw new TypeError('activity: invalid base path')
  return async (request: Request): Promise<Response | null> => {
    const url = new URL(request.url)
    if (url.pathname !== base && !url.pathname.startsWith(`${base}/`)) return null
    const admin = await requireAdmin(request)
    if (admin instanceof Response) {
      const response = new Response(admin.body, admin)
      response.headers.set('cache-control', 'no-store')
      return response
    }
    if (!admin || typeof admin !== 'object' || Array.isArray(admin) || typeof admin.who !== 'string' || !admin.who.trim()) return json({ error: 'admin required' }, 403)
    if (request.method !== 'GET' && request.headers.get('origin') !== url.origin) return json({ error: 'cross-origin mutation refused' }, 403)
    const path = url.pathname.slice(base.length)
    if (request.method === 'GET' && (path === '' || path === '/')) {
      const filter: ActivityFilter = {}
      for (const key of ['actorId', 'origin'] as const) {
        const value = url.searchParams.get(key)
        if (value !== null) {
          try { activityText(value, key) } catch { return json({ error: `invalid ${key}` }, 400) }
          filter[key] = value
        }
      }
      for (const key of ['since', 'limit'] as const) {
        const value = url.searchParams.get(key)
        if (value !== null) {
          const n = Number(value)
          if (!/^\d+$/.test(value) || !Number.isSafeInteger(n) || n < (key === 'limit' ? 1 : 0) || (key === 'limit' && n > 500)) {
            return json({ error: `invalid ${key}` }, 400)
          }
          filter[key] = n
        }
      }
      return json({ bursts: await store.list(filter) })
    }
    if (request.method === 'GET' && path === '/kinds') return json({ kinds: await feed.kinds() })
    if (request.method === 'PUT' && path.startsWith('/kinds/')) {
      let kind: string
      try { kind = decodeURIComponent(path.slice('/kinds/'.length)) } catch { return json({ error: 'invalid kind or policy' }, 400) }
      if (!/^[a-z][a-z0-9_.-]{0,63}$/.test(kind)) return json({ error: 'invalid kind or policy' }, 400)
      const body = await readPolicy(request)
      if (body instanceof Response) return body
      if (!body || typeof body !== 'object' || Array.isArray(body)) return json({ error: 'invalid policy' }, 400)
      const policy = body as Record<string, unknown>
      if (Object.keys(policy).sort().join(',') !== 'notify,record' || typeof policy.record !== 'string' || typeof policy.notify !== 'string' || !['off', 'count', 'line'].includes(policy.record) || !['off', 'count', 'line'].includes(policy.notify)) {
        return json({ error: 'invalid policy' }, 400)
      }
      try {
        await feed.setKind(kind, { record: policy.record as 'off' | 'count' | 'line', notify: policy.notify as 'off' | 'count' | 'line' })
      } catch (error) {
        if (error instanceof TypeError || error instanceof URIError) return json({ error: 'invalid kind or policy' }, 400)
        throw error
      }
      return json({ kinds: await feed.kinds() })
    }
    if (request.method === 'GET' && /^\/[^/]+$/.test(path)) {
      let id: string
      try { id = decodeURIComponent(path.slice(1)) } catch { return json({ error: 'invalid burst id' }, 400) }
      if (!id.trim() || id.length > 512 || /[\u0000-\u001f]/.test(id)) return json({ error: 'invalid burst id' }, 400)
      const burst = await store.get(id)
      return burst ? json({ burst }) : json({ error: 'not found' }, 404)
    }
    return json({ error: 'not found' }, 404)
  }
}
