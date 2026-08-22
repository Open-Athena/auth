/**
 * Deciding an access request from the notification.
 *
 * The acceptance list in `specs/decision-links.md`, in order. The one worth
 * reading twice is "a GET decides nothing" — that is the guard against mail
 * scanners approving requests on an admin's behalf, and it is invisible in the
 * happy path.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { EMAIL_LINK_ACTOR, mintDecisionTokens, readDecisionToken } from '../src/core/decisions.js'
import { type Gate, createGate } from '../src/core/gate.js'
import { domainPolicy } from '../src/core/policy.js'
import type { NotifyEvent } from '../src/core/requests.js'
import { authRoutes } from '../src/core/routes.js'
import { memoryAudit, memoryRequestStore, memoryStore } from './memory-store.js'

const SECRET = 'test-secret-0123456789abcdef'
const T0 = 1_700_000_000_000

let events: NotifyEvent[]

const build = (decisionLinks: Parameters<typeof createGate>[0]['decisionLinks'] = {}): Gate =>
  createGate({
    store: memoryStore(),
    requests: memoryRequestStore(),
    audit: memoryAudit(),
    secret: SECRET,
    policy: domainPolicy(['staff.test'], ['reports']),
    approvalGrant: { scopes: ['reports'] },
    decisionLinks,
    notify: async e => void events.push(e),
  })

const req = () => new Request('https://app.test/request', { headers: { 'CF-Connecting-IP': '203.0.113.7' } })

/** Queue a pending request and return the two tokens the notification carried. */
async function pending(gate: Gate): Promise<{ id: string; approve: string; deny: string }> {
  const res = await gate.requestAccess({ email: 'grace@outside.test', name: 'Grace Hopper' }, req())
  if (res.status !== 'pending') throw new Error(`expected pending, got ${res.status}`)
  const ev = events.find(e => e.kind === 'access-requested')
  if (ev?.kind !== 'access-requested' || !ev.decision) throw new Error('no decision tokens on the event')
  return { id: res.request.id, ...ev.decision }
}

beforeEach(() => {
  events = []
})

describe('decision tokens', () => {
  it('binds the verb into the signature, so an approve link cannot be edited from a deny', async () => {
    const { approve, deny } = await mintDecisionTokens('req_1', SECRET, T0)
    expect(await readDecisionToken(approve, SECRET, T0)).toEqual({ verb: 'approve', requestId: 'req_1' })
    expect(await readDecisionToken(deny, SECRET, T0)).toEqual({ verb: 'deny', requestId: 'req_1' })

    // The payload is base64url'd JSON, so "edit the verb" means re-encoding the
    // claim — which invalidates the HMAC over it.
    const [body] = deny.split('.')
    const claim = JSON.parse(Buffer.from(body!, 'base64url').toString())
    expect(claim.sub).toBe('decide:deny:req_1')
    const forgedBody = Buffer.from(JSON.stringify({ ...claim, sub: 'decide:approve:req_1' })).toString('base64url')
    expect(await readDecisionToken(`${forgedBody}.${deny.split('.')[1]}`, SECRET, T0)).toBeNull()
  })

  it('is inert on a different request, and after it expires', async () => {
    const { approve } = await mintDecisionTokens('req_1', SECRET, T0, 60)
    // Same secret, same verb, different request: the id is inside the signature.
    const other = await mintDecisionTokens('req_2', SECRET, T0, 60)
    expect(await readDecisionToken(other.approve, SECRET, T0)).toEqual({ verb: 'approve', requestId: 'req_2' })
    expect(await readDecisionToken(approve, SECRET, T0 + 61_000)).toBeNull()
    expect(await readDecisionToken(approve, 'a-different-secret-aaaaaaaaaaaa', T0)).toBeNull()
  })
})

describe('gate.decide', () => {
  it('decides nothing on a read-only pass, so a mail scanner cannot approve for you', async () => {
    const gate = build()
    const { id, approve } = await pending(gate)

    // Exactly what Outlook Safe Links does to every URL in the message.
    const view = await gate.decide(approve, { nowMs: T0 })

    expect(view.kind).toBe('confirm')
    expect(events.map(e => e.kind)).toEqual(['access-requested'])
    const after = await gate.listRequests()
    expect(after.map(r => [r.id, r.status, r.decidedBy])).toEqual([[id, 'pending', null]])
  })

  it('approves on commit, mails the link, and records that nobody was identified', async () => {
    const gate = build()
    const { id, approve } = await pending(gate)

    const view = await gate.decide(approve, { commit: true, nowMs: T0 })

    expect(view.kind).toBe('decided')
    if (view.kind !== 'decided') throw new Error('unreachable')
    expect([view.verb, view.reversed, view.request.status, view.request.decidedBy]).toEqual([
      'approve',
      false,
      'approved',
      EMAIL_LINK_ACTOR,
    ])
    const granted = events.find(e => e.kind === 'access-granted')
    expect(granted?.kind === 'access-granted' && granted.request.id).toBe(id)
  })

  it('names the admin when one authenticated', async () => {
    const gate = build({ requireAuth: true })
    const { deny } = await pending(gate)

    expect((await gate.decide(deny, { commit: true, nowMs: T0 })).kind).toBe('unauthorized')
    const view = await gate.decide(deny, { commit: true, actor: 'ada@staff.test', nowMs: T0 })

    expect(view.kind === 'decided' && view.request.decidedBy).toBe('ada@staff.test')
  })

  it('treats a second click of the same verb as a no-op, not an error', async () => {
    const gate = build()
    const { approve } = await pending(gate)
    await gate.decide(approve, { commit: true, nowMs: T0 })

    const again = await gate.decide(approve, { commit: true, nowMs: T0 + 1000 })

    expect(again.kind).toBe('already')
    // The important half: no second grant, and no second link in the post.
    expect(events.filter(e => e.kind === 'access-granted').length).toBe(1)
    expect((await gate.list()).length).toBe(1)
  })

  it('rejects a token whose request no longer exists the same way it rejects a forgery', async () => {
    const gate = build()
    const { approve } = await mintDecisionTokens('req_does_not_exist', SECRET, T0)
    expect((await gate.decide(approve, { commit: true, nowMs: T0 })).kind).toBe('invalid')
    expect((await gate.decide('not-a-token', { commit: true, nowMs: T0 })).kind).toBe('invalid')
  })

  it('is off entirely without config: no tokens minted, no decisions accepted', async () => {
    const gate = createGate({
      store: memoryStore(),
      requests: memoryRequestStore(),
      secret: SECRET,
      policy: domainPolicy(['staff.test'], ['reports']),
      notify: async e => void events.push(e),
    })
    const res = await gate.requestAccess({ email: 'grace@outside.test' }, req())
    expect(res.status).toBe('pending')
    const ev = events.find(e => e.kind === 'access-requested')
    expect(ev?.kind === 'access-requested' && ev.decision).toBeUndefined()

    const { approve } = await mintDecisionTokens('whatever', SECRET, T0)
    expect((await gate.decide(approve, { commit: true, nowMs: T0 })).kind).toBe('invalid')
  })
})

describe('reversal', () => {
  it('deny-wins: a deny takes back the grant, it does not merely relabel the row', async () => {
    const gate = build()
    const { approve, deny } = await pending(gate)
    await gate.decide(approve, { commit: true, nowMs: T0 })
    const granted = events.find(e => e.kind === 'access-granted')
    if (granted?.kind !== 'access-granted') throw new Error('no grant')

    // The link is live and usable at this point — that is the whole problem a
    // reversal has to solve.
    expect((await gate.redeem(granted.token, req())).ok).toBe(true)

    const view = await gate.decide(deny, { commit: true, nowMs: T0 + 60_000 })

    expect(view.kind === 'decided' && [view.verb, view.reversed, view.request.status]).toEqual([
      'deny',
      true,
      'denied',
    ])
    expect(await gate.redeem(granted.token, req())).toEqual({ ok: false, reason: 'revoked' })
  })

  it('deny-wins: an approve never overrides a deny', async () => {
    const gate = build()
    const { approve, deny } = await pending(gate)
    await gate.decide(deny, { commit: true, nowMs: T0 })

    const view = await gate.decide(approve, { commit: true, nowMs: T0 + 60_000 })

    expect(view.kind === 'already' && view.request.status).toBe('denied')
    expect(events.filter(e => e.kind === 'access-granted').length).toBe(0)
  })

  it('first-wins: nothing reverses', async () => {
    const gate = build({ reversal: 'first-wins' })
    const { approve, deny } = await pending(gate)
    await gate.decide(approve, { commit: true, nowMs: T0 })

    const view = await gate.decide(deny, { commit: true, nowMs: T0 + 60_000 })

    expect(view.kind === 'already' && view.request.status).toBe('approved')
  })

  it('last-wins: an approve can reverse a deny, and mints a fresh link', async () => {
    const gate = build({ reversal: 'last-wins' })
    const { approve, deny } = await pending(gate)
    await gate.decide(deny, { commit: true, nowMs: T0 })
    expect(events.filter(e => e.kind === 'access-granted').length).toBe(0)

    const view = await gate.decide(approve, { commit: true, nowMs: T0 + 60_000 })

    expect(view.kind === 'decided' && [view.reversed, view.request.status]).toEqual([true, 'approved'])
    const granted = events.find(e => e.kind === 'access-granted')
    if (granted?.kind !== 'access-granted') throw new Error('no grant')
    expect((await gate.redeem(granted.token, req())).ok).toBe(true)
  })

  it('stops reversing once the window closes', async () => {
    const gate = build({ reversalWindowS: 600 })
    const { approve, deny } = await pending(gate)
    await gate.decide(approve, { commit: true, nowMs: T0 })

    const inside = await gate.decide(deny, { commit: true, nowMs: T0 + 599_000 })
    expect(inside.kind).toBe('decided')

    // A fresh request, decided and then left alone past the window.
    events = []
    const gate2 = build({ reversalWindowS: 600 })
    const b = await pending(gate2)
    await gate2.decide(b.approve, { commit: true, nowMs: T0 })
    const outside = await gate2.decide(b.deny, { commit: true, nowMs: T0 + 601_000 })

    expect(outside.kind === 'already' && outside.request.status).toBe('approved')
  })
})


/** The bits of the confirmation form that matter, so the assertion can be an equality. */
const formOf = (html: string) => {
  const form = /<form method="(\w+)" action="([^"]*)">([\s\S]*?)<\/form>/.exec(html)
  if (!form) throw new Error('no form in the page')
  const [, method, action, inner] = form as unknown as [string, string, string, string]
  const hidden = Object.fromEntries(
    [...inner.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)].map(m => [m[1], m[2]]),
  )
  const button = /<button type="submit" class="\w+">([^<]*)<\/button>/.exec(inner)?.[1]
  return { method, action, hidden, button }
}

const headingOf = (html: string): string => /<h1>([^<]*)<\/h1>/.exec(html)?.[1] ?? ''

describe('the /decide endpoint', () => {
  const handleFor = (gate: Gate) => authRoutes(gate, { decisionAppName: 'the reports' })
  const at = (t: string) => `https://app.test/api/auth/decide${t}`

  it('renders a confirmation page for a GET and commits only on the form POST', async () => {
    const gate = build()
    const handle = handleFor(gate)
    const { id, approve } = await pending(gate)

    const shown = await handle(new Request(at(`?t=${encodeURIComponent(approve)}`)))
    const html = await shown!.text()

    expect([shown!.status, shown!.headers.get('content-type')]).toEqual([200, 'text/html; charset=utf-8'])
    // The token is round-tripped through a hidden field, so the POST that
    // follows carries it without it ever landing in a form's query string.
    expect(formOf(html)).toEqual({
      method: 'post',
      action: '/api/auth/decide',
      hidden: { t: approve },
      button: 'Approve',
    })
    expect((await gate.listRequests()).map(r => r.status)).toEqual(['pending'])

    // A real <form> submit: urlencoded, not JSON.
    const posted = await handle(
      new Request(at(''), {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ t: approve }),
      }),
    )

    expect(posted!.status).toBe(200)
    expect((await gate.listRequests()).map(r => [r.id, r.status])).toEqual([[id, 'approved']])
  })

  it('answers a junk token with one indistinguishable page', async () => {
    const handle = handleFor(build())
    const res = await handle(new Request(at('?t=nonsense')))
    expect([res!.status, headingOf(await res!.text())]).toEqual([404, 'This link is no longer valid'])
  })
})
