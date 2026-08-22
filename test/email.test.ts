/**
 * The magic-link delivery path, end to end through the gate: an address is
 * auto-approved, a grant is minted, and the *only* copy of the token leaves in
 * an email to the address it is bound to.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { resendEmail } from '../src/adapters/resend.js'
import { type EmailMessage, emailNotify } from '../src/core/email.js'
import { createGate } from '../src/core/gate.js'
import { anyEmailPolicy, domainPolicy } from '../src/core/policy.js'
import type { Grant } from '../src/core/types.js'
import type { AccessRequest } from '../src/core/requests.js'
import { memoryAudit, memoryRequestStore, memoryStore } from './memory-store.js'

const SECRET = 'test-secret-0123456789abcdef'
const FROM = 'Demo <auth@example.test>'

let sent: EmailMessage[]
let fail: string | null

const send = async (msg: EmailMessage) => {
  sent.push(msg)
  return fail ? { ok: false as const, error: fail } : { ok: true as const, id: 'msg_1' }
}

const notify = (over: Partial<Parameters<typeof emailNotify>[0]> = {}) =>
  emailNotify({
    send,
    from: FROM,
    appName: 'the reports',
    linkFor: token => `https://app.test/dashboard?key=${token}`,
    ...over,
  })

const gate = (policy = anyEmailPolicy(['reports']), notifyOpts = {}) =>
  createGate({
    store: memoryStore(),
    requests: memoryRequestStore(),
    audit: memoryAudit(),
    secret: SECRET,
    policy,
    approvalGrant: { scopes: ['reports'] },
    notify: notify(notifyOpts),
  })

const req = () => new Request('https://app.test/request', { headers: { 'CF-Connecting-IP': '203.0.113.7' } })

beforeEach(() => {
  sent = []
  fail = null
})

const GRANT = { id: 'g1' } as unknown as Grant

const pending = (email: string): AccessRequest => ({
  id: 'r1',
  email,
  name: null,
  subject: null,
  note: null,
  createdAt: 0,
  status: 'pending',
  decidedAt: null,
  decidedBy: null,
  grantId: null,
})

describe('emailNotify', () => {
  it('delivers the link to the address it is bound to, and nowhere else', async () => {
    // `adminTo` is configured on purpose: the token must not reach the admin
    // even when there is an admin to reach. Without this the assertion below
    // would pass for want of anyone else to leak to.
    const g = gate(anyEmailPolicy(['reports']), { adminTo: 'boss@openathena.ai' })
    const res = await g.requestAccess({ email: 'grace@example.com', name: 'Grace Hopper' }, req())
    if (res.status !== 'auto') throw new Error('expected auto-approval')

    expect(sent.map(m => [m.to, m.from, m.subject])).toEqual([['grace@example.com', FROM, 'Your link to the reports']])
    // Delivery *is* the verification, so the token must be in the body of the
    // mail to that address — and the subject must not carry it, since subjects
    // are logged, previewed on lock screens, and quoted in replies.
    expect(sent[0]!.text).toContain(res.token)
    expect(sent[0]!.subject).not.toContain(res.token)
    expect(sent[0]!.text.startsWith('Hi Grace,')).toBe(true)
  })

  it('tells an admin about a pending request, without a token in it', async () => {
    const g = gate(domainPolicy(['openathena.ai'], ['reports']), {
      adminTo: 'boss@openathena.ai',
      adminUrl: 'https://app.test/admin',
    })
    const res = await g.requestAccess({ email: 'grace@example.com', note: 'reviewing Q3' }, req())
    expect(res.status).toBe('pending')

    const [msg] = sent
    expect([msg!.to, msg!.subject, msg!.replyTo]).toEqual([
      'boss@openathena.ai',
      'Access request from grace@example.com',
      // Replying reaches the requester, which is what an admin does first.
      'grace@example.com',
    ])
    expect(msg!.text.split('\n')).toEqual([
      'grace@example.com asked for access to the reports.',
      '',
      'They said: reviewing Q3',
      '',
      'Approve or deny: https://app.test/admin',
    ])
  })

  it('sends nothing when there is no admin address configured', async () => {
    const g = gate(domainPolicy(['openathena.ai'], ['reports']))
    await g.requestAccess({ email: 'grace@example.com' }, req())
    expect(sent).toEqual([])
  })

  it('stays silent on a denial', async () => {
    const g = gate(domainPolicy(['openathena.ai'], ['reports']), { adminTo: 'boss@openathena.ai' })
    const res = await g.requestAccess({ email: 'grace@example.com' }, req())
    if (res.status !== 'pending') throw new Error('expected pending')
    sent.length = 0

    await g.denyRequest(res.request.id, 'boss@openathena.ai')
    // A denial notice confirms to a prober that the address exists and that a
    // human looked, and carries nothing actionable for a real requester.
    expect(sent).toEqual([])
  })

  it('withholds the link from an address it will not mail, and hands back the token instead', async () => {
    // The allowlist case: a public form must not mail every address a stranger
    // types. `onUndelivered` is what lets the caller show the link on screen.
    const undelivered: string[] = []
    const n = notify({
      adminTo: 'boss@openathena.ai',
      deliverTo: addr => addr.endsWith('@openathena.ai'),
      onUndelivered: e => undelivered.push(e.token),
    })
    await n({ kind: 'access-granted', request: pending('stranger@elsewhere.test'), grant: GRANT, token: 'tok_abc' })

    expect(sent).toEqual([])
    expect(undelivered).toEqual(['tok_abc'])
  })

  it('tells the admin about a request it would never mail the requester about', async () => {
    // The regression this guards: gating admin notifications on the same
    // predicate as recipient delivery drops exactly the requests worth seeing —
    // the ones from outside your own domains.
    const n = notify({ adminTo: 'boss@openathena.ai', deliverTo: () => false })
    await n({ kind: 'access-requested', request: pending('stranger@elsewhere.test') })

    expect(sent.map(m => [m.to, m.replyTo, m.subject])).toEqual([
      ['boss@openathena.ai', 'stranger@elsewhere.test', 'Access request from stranger@elsewhere.test'],
    ])
  })

  it('surfaces a send failure without failing the sign-up that triggered it', async () => {
    fail = 'resend 403: domain is not verified'
    const errors: string[] = []
    const g = gate(anyEmailPolicy(['reports']), { onError: (e: string) => errors.push(e) })

    // The grant is already minted by the time mail is attempted; throwing here
    // would turn "the mail didn't go out" into "sign-up is broken".
    const res = await g.requestAccess({ email: 'grace@example.com' }, req())
    expect([res.status, errors]).toEqual(['auto', ['resend 403: domain is not verified']])
  })
})

describe('resendEmail', () => {
  const ok = (body: unknown, status = 200) =>
    (async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })) as typeof globalThis.fetch

  it('posts what Resend expects, renaming only what it insists on', async () => {
    let seen: { url: string; init: RequestInit } | null = null
    const fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      seen = { url: String(url), init: init! }
      return new Response(JSON.stringify({ id: 'abc' }), { status: 200 })
    }) as typeof globalThis.fetch

    const res = await resendEmail({ apiKey: 're_test', fetch })({
      from: FROM,
      to: 'grace@example.com',
      subject: 'hi',
      text: 'body',
      replyTo: 'boss@openathena.ai',
    })

    expect(res).toEqual({ ok: true, id: 'abc' })
    const { url, init } = seen!
    expect([url, init.method, (init.headers as Record<string, string>).authorization]).toEqual([
      'https://api.resend.com/emails',
      'POST',
      'Bearer re_test',
    ])
    expect(JSON.parse(init.body as string)).toEqual({
      from: FROM,
      // Always an array, and `reply_to` is snake_case — the two places the
      // wire format differs from ours.
      to: ['grace@example.com'],
      subject: 'hi',
      text: 'body',
      reply_to: 'boss@openathena.ai',
    })
  })

  it("hands back the provider's complaint rather than a bare failure", async () => {
    const fetch = (async () => new Response('{"message":"The example.test domain is not verified"}', { status: 403 })) as typeof globalThis.fetch
    const res = await resendEmail({ apiKey: 're_test', from: FROM, fetch })({
      to: 'grace@example.com',
      subject: 'hi',
      text: 'body',
    })
    // "Domain not verified" is the error everyone hits first, and a magic-link
    // flow that silently sends nothing is the worst way to learn it.
    expect(res).toEqual({ ok: false, error: 'resend 403: {"message":"The example.test domain is not verified"}' })
  })

  it('refuses to send with no `from` at all', async () => {
    const res = await resendEmail({ apiKey: 're_test', fetch: ok({}) })({ to: 'a@b.test', subject: 's', text: 't' })
    expect(res).toEqual({ ok: false, error: 'no `from` address configured' })
  })
})
