/**
 * The email-code sign-in flow. A fake `SendEmail` captures each message, so a
 * test can read back the 6-digit code and magic-link token the real recipient
 * would — the whole path (start → deliver → verify → mint) runs, not a mock of
 * its middle.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { emailCodeAuth } from '../src/core/email-codes.js'
import type { EmailMessage, SendResult } from '../src/core/email.js'
import { createGate } from '../src/core/gate.js'
import { domainPolicy } from '../src/core/policy.js'
import { hashIp } from '../src/core/tokens.js'
import { memoryPendingAuthStore } from '../src/testing/index.js'
import { memoryStore } from './memory-store.js'

const SECRET = 'test-secret-0123456789abcdef'
const NOW = Date.parse('2026-09-19T00:00:00Z')
const ALLOWED = 'user@openathena.ai'
const STRANGER = 'nope@example.com'

const setCookies = (res: Response): string[] => (res.headers as unknown as { getSetCookie(): string[] }).getSetCookie()

let sent: EmailMessage[]
let store: ReturnType<typeof memoryPendingAuthStore>
let flow: ReturnType<typeof emailCodeAuth>

const linkFor = (token: string) => `https://app.test/auth/email/link?token=${token}`

/** The code and the link token out of the one message we sent to `email`. */
function delivered(email: string): { code: string; token: string } {
  const msg = sent.find(m => m.to === email)
  if (!msg) throw new Error(`no email sent to ${email}`)
  const code = /\b(\d{6})\b/.exec(msg.text)?.[1]
  const token = /token=([\w-]+)/.exec(msg.text)?.[1]
  if (!code || !token) throw new Error('code/token not in message')
  return { code, token }
}

const startReq = (email: string) =>
  flow.start({ request: new Request('https://app.test/auth/email/start', { method: 'POST', body: JSON.stringify({ email }) }) })
const verifyCodeReq = (id: string, code: string) =>
  flow.verifyCode({
    request: new Request('https://app.test/auth/email/code', { method: 'POST', body: JSON.stringify({ id, code }) }),
  })
const verifyLinkReq = (token: string) =>
  flow.verifyLink({ request: new Request(`https://app.test/auth/email/link?token=${token}&next=/reports`) })
const pollReq = (id: string) => flow.poll({ request: new Request(`https://app.test/auth/email/poll?id=${id}`) })

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  sent = []
  const gate = createGate({ store: memoryStore(), secret: SECRET, policy: domainPolicy(['openathena.ai'], ['read']) })
  store = memoryPendingAuthStore()
  flow = emailCodeAuth({
    gate,
    store,
    send: async (msg): Promise<SendResult> => {
      sent.push(msg)
      return { ok: true }
    },
    from: 'Auth <noreply@app.test>',
    linkFor,
    ttlS: 900,
    maxAttempts: 3,
    rateLimit: { windowS: 900, maxPerEmail: 3 },
  })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('start — no allowlist oracle', () => {
  it('answers identically for an allowed and a not-allowed address', async () => {
    const allowed = (await (await startReq(ALLOWED)).json()) as Record<string, unknown>
    const stranger = (await (await startReq(STRANGER)).json()) as Record<string, unknown>
    // Same keys, same status, an opaque string id in both — nothing distinguishes
    // "on the allowlist" from "not".
    expect(Object.keys(allowed).sort()).toEqual(['id', 'status'])
    expect(Object.keys(stranger).sort()).toEqual(['id', 'status'])
    expect([allowed.status, stranger.status]).toEqual(['sent', 'sent'])
    expect([typeof allowed.id, typeof stranger.id]).toEqual(['string', 'string'])
  })

  it('mails only the allowed address, though both got the same response', async () => {
    await startReq(ALLOWED)
    await startReq(STRANGER)
    expect(sent.map(m => m.to)).toEqual([ALLOWED])
  })

  it('rejects a malformed address — a client error, not an allowlist signal', async () => {
    expect((await (await startReq('not-an-email')).json()) as unknown).toEqual({ status: 'invalid-email' })
  })
})

describe('verifyCode — the cross-device rescue', () => {
  it('mints a session into this response for the right code', async () => {
    const { id } = (await (await startReq(ALLOWED)).json()) as { id: string }
    const { code } = delivered(ALLOWED)
    const res = await verifyCodeReq(id, code)
    expect([res.status, await res.json()]).toEqual([200, { ok: true }])
    expect(setCookies(res).some(c => c.startsWith('oa_auth='))).toBe(true)
  })

  it('is single-use: the same code cannot mint twice', async () => {
    const { id } = (await (await startReq(ALLOWED)).json()) as { id: string }
    const { code } = delivered(ALLOWED)
    await verifyCodeReq(id, code)
    const second = await verifyCodeReq(id, code)
    expect([second.status, await second.json()]).toEqual([400, { ok: false }])
    expect(setCookies(second).some(c => c.startsWith('oa_auth='))).toBe(false)
  })

  it('rejects the wrong code and locks the row after too many guesses', async () => {
    const { id } = (await (await startReq(ALLOWED)).json()) as { id: string }
    const { code } = delivered(ALLOWED)
    const wrong = code === '000000' ? '111111' : '000000'
    const statuses = [
      (await verifyCodeReq(id, wrong)).status,
      (await verifyCodeReq(id, wrong)).status,
      (await verifyCodeReq(id, wrong)).status,
      // Even the *right* code is refused once the attempt cap is spent.
      (await verifyCodeReq(id, code)).status,
    ]
    expect(statuses).toEqual([400, 400, 400, 400])
  })

  it('rejects an expired code', async () => {
    const { id } = (await (await startReq(ALLOWED)).json()) as { id: string }
    const { code } = delivered(ALLOWED)
    vi.setSystemTime(NOW + 901_000)
    const res = await verifyCodeReq(id, code)
    expect([res.status, await res.json()]).toEqual([400, { ok: false }])
  })

  it('gives the same {ok:false} for an unknown id as for a wrong code', async () => {
    const res = await verifyCodeReq('no-such-id', '123456')
    expect([res.status, await res.json()]).toEqual([400, { ok: false }])
  })
})

describe('verifyLink — the same-device happy path', () => {
  it('signs in the clicking browser and redirects to next', async () => {
    await startReq(ALLOWED)
    const { token } = delivered(ALLOWED)
    const res = await verifyLinkReq(token)
    expect([res.status, res.headers.get('location')]).toEqual([302, '/reports'])
    expect(setCookies(res).some(c => c.startsWith('oa_auth='))).toBe(true)
  })

  it('spends the link: a second click mints nothing', async () => {
    await startReq(ALLOWED)
    const { token } = delivered(ALLOWED)
    await verifyLinkReq(token)
    const second = await verifyLinkReq(token)
    expect(second.status).toBe(302)
    expect(setCookies(second).some(c => c.startsWith('oa_auth='))).toBe(false)
  })
})

describe('poll', () => {
  it('reports pending, then used, and never confirms an unknown id exists', async () => {
    const { id } = (await (await startReq(ALLOWED)).json()) as { id: string }
    expect((await (await pollReq(id)).json()) as unknown).toEqual({ status: 'pending' })
    const { token } = delivered(ALLOWED)
    await verifyLinkReq(token)
    expect((await (await pollReq(id)).json()) as unknown).toEqual({ status: 'used' })
    expect((await (await pollReq('no-such-id')).json()) as unknown).toEqual({ status: 'expired' })
  })
})

describe('rate limiting', () => {
  it('stops mailing an address after the cap, still answering "sent"', async () => {
    for (let i = 0; i < 5; i++) await startReq(ALLOWED)
    // maxPerEmail is 3; the 4th and 5th start send no mail.
    expect(sent.length).toBe(3)
    const last = (await (await startReq(ALLOWED)).json()) as Record<string, unknown>
    expect(last.status).toBe('sent')
  })

  it('caps sends per source IP across addresses, storing the hashed IP', async () => {
    const IP = '203.0.113.7'
    const gate = createGate({ store: memoryStore(), secret: SECRET, policy: domainPolicy(['openathena.ai'], ['read']) })
    const st = memoryPendingAuthStore()
    // maxPerEmail high so the per-address cap can't be what stops us; maxPerIp = 2.
    const local = emailCodeAuth({
      gate,
      store: st,
      send: async (msg): Promise<SendResult> => {
        sent.push(msg)
        return { ok: true }
      },
      from: 'Auth <noreply@app.test>',
      linkFor,
      rateLimit: { maxPerEmail: 100, maxPerIp: 2 },
    })
    const fromIp = (email: string) =>
      local.start({
        request: new Request('https://app.test/auth/email/start', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'CF-Connecting-IP': IP },
          body: JSON.stringify({ email }),
        }),
      })

    await fromIp('a@openathena.ai')
    await fromIp('b@openathena.ai')
    const third = (await (await fromIp('c@openathena.ai')).json()) as Record<string, unknown>

    // Two distinct addresses mailed, the third capped — but the response shape
    // is unchanged, so the cap isn't observable as a distinct answer.
    expect(sent.map(m => m.to)).toEqual(['a@openathena.ai', 'b@openathena.ai'])
    expect(third.status).toBe('sent')
    // Every stored row carries the HMAC of the IP (never the raw address), by
    // the same `hashIp` scheme the access log uses.
    const expected = await hashIp(IP, SECRET)
    expect([...st.rows.values()].map(r => r.ipHash)).toEqual([expected, expected])
  })

  it('skips the per-IP cap gracefully when no IP header is present', async () => {
    // The default flow sends with no CF-Connecting-IP; per-IP must not throw or
    // block, and rows record a null ipHash.
    const res = (await (await startReq(ALLOWED)).json()) as Record<string, unknown>
    expect(res.status).toBe('sent')
    expect([...store.rows.values()].map(r => r.ipHash)).toEqual([null])
  })
})

describe('start — waitUntil defers delivery', () => {
  it('schedules the send instead of awaiting it inline', async () => {
    const scheduled: Promise<unknown>[] = []
    let release!: () => void
    const gate = createGate({ store: memoryStore(), secret: SECRET, policy: domainPolicy(['openathena.ai'], ['read']) })
    const local = emailCodeAuth({
      gate,
      store: memoryPendingAuthStore(),
      // Delivery blocks until released, so "already delivered" would prove it
      // was awaited inline.
      send: async (msg): Promise<SendResult> => {
        await new Promise<void>(r => {
          release = () => {
            sent.push(msg)
            r()
          }
        })
        return { ok: true }
      },
      from: 'Auth <noreply@app.test>',
      linkFor,
    })

    const res = await local.start({
      request: new Request('https://app.test/auth/email/start', {
        method: 'POST',
        body: JSON.stringify({ email: ALLOWED }),
      }),
      waitUntil: p => scheduled.push(p),
    })
    const parsed = (await res.json()) as Record<string, unknown>

    // The response is back and exactly one send was handed to waitUntil, but no
    // mail has been delivered yet — it wasn't awaited inline.
    expect([parsed.status, typeof parsed.id]).toEqual(['sent', 'string'])
    expect([scheduled.length, sent.length]).toEqual([1, 0])

    // Draining the scheduled work delivers it.
    release()
    await scheduled[0]
    expect(sent.map(m => m.to)).toEqual([ALLOWED])
  })
})
