#!/usr/bin/env node
/**
 * A black-box check of an OIDC provider over HTTP: the same checks against
 * ours (`@open-athena/auth/provider`) and anyone else's, for a like-for-like
 * comparison. It plays the relying party by hand (it never follows a redirect
 * to an app), with a broker session cookie standing in for a signed-in
 * browser.
 *
 *   scripts/oidc-probe.mjs --config tmp/probe.json
 *   scripts/oidc-probe.mjs --demo http://localhost:4187
 *
 * Config (JSON; secrets stay in the file, not on the command line):
 *   { "issuer": "…", "cookie": "<Cookie header of a signed-in broker session>",
 *     "clients": [{ "id": "…", "secret": "…", "redirectUri": "…" }, …] }   // 1 or 2
 *
 * `--demo <origin>` builds that for this repo's demo: it signs a throwaway
 * address in by emailed code (the demo shows the code) and derives the demo
 * RP's client secret from `demo/.dev.vars`' `SESSION_SECRET`, never printing it.
 */
import { createHash, createHmac, randomBytes, webcrypto } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'

const { subtle } = webcrypto
const { values: args } = parseArgs({ options: { config: { type: 'string', short: 'c' }, demo: { type: 'string', short: 'd' } } })

const b64u = buf => Buffer.from(buf).toString('base64url')
const sha256 = s => createHash('sha256').update(s).digest()

async function demoConfig(origin) {
  const vars = readFileSync(new URL('../demo/.dev.vars', import.meta.url), 'utf8')
  const secret = vars.match(/^SESSION_SECRET=(.*)$/m)?.[1]?.trim().replace(/^"|"$/g, '')
  if (!secret) throw new Error('no SESSION_SECRET in demo/.dev.vars')
  const email = `probe-${Date.now()}@example.test`
  const jar = new Map()
  const take = res => {
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';')
      const i = pair.indexOf('=')
      jar.set(pair.slice(0, i), pair.slice(i + 1))
    }
  }
  const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ')
  const post = async (path, body) => {
    const res = await fetch(`${origin}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: cookie(), origin }, body: JSON.stringify(body) })
    take(res)
    return res
  }
  const { id } = await (await post('/auth/email/start', { email })).json()
  const box = await (await fetch(`${origin}/auth/email/outbox`, { headers: { cookie: cookie() } })).json()
  const verified = await post('/auth/email/code', { id, code: box.code })
  if (!verified.ok) throw new Error(`demo sign-in failed: ${verified.status}`)
  return {
    issuer: origin,
    cookie: cookie(),
    clients: [{ id: 'demo-rp', secret: b64u(createHmac('sha256', secret).update('demo-rp-client').digest()), redirectUri: `${origin}/rp/callback` }],
    email,
  }
}

const cfg = args.demo ? await demoConfig(args.demo.replace(/\/+$/, '')) : JSON.parse(readFileSync(args.config, 'utf8'))
const [A, B] = cfg.clients

const results = []
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail })

// ---- discovery and keys ----
const disc = await (await fetch(`${cfg.issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`)).json()
check('discovery issuer matches', disc.issuer === cfg.issuer, disc.issuer)
check('advertises S256 PKCE', (disc.code_challenge_methods_supported ?? []).includes('S256'), JSON.stringify(disc.code_challenge_methods_supported))
check('does not advertise plain PKCE', !(disc.code_challenge_methods_supported ?? []).includes('plain'))
check('code flow only', JSON.stringify(disc.response_types_supported) === '["code"]', JSON.stringify(disc.response_types_supported))
check('end_session_endpoint', typeof disc.end_session_endpoint === 'string')
const jwks = await (await fetch(disc.jwks_uri)).json()

async function verifyJwt(jwt) {
  const [h, p, s] = jwt.split('.')
  const header = JSON.parse(Buffer.from(h, 'base64url'))
  const jwk = jwks.keys.find(k => k.kid === header.kid) ?? (jwks.keys.length === 1 ? jwks.keys[0] : null)
  if (!jwk) return { ok: false, why: `no key ${header.kid}` }
  const algs = {
    RS256: [{ name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, 'RSASSA-PKCS1-v1_5'],
    ES256: [{ name: 'ECDSA', namedCurve: 'P-256' }, { name: 'ECDSA', hash: 'SHA-256' }],
    EdDSA: [{ name: 'Ed25519' }, { name: 'Ed25519' }],
  }[header.alg]
  if (!algs) return { ok: false, why: `alg ${header.alg}` }
  const { d: _d, key_ops: _o, ...pub } = jwk
  const key = await subtle.importKey('jwk', pub, algs[0], false, ['verify'])
  const ok = await subtle.verify(algs[1], key, Buffer.from(s, 'base64url'), Buffer.from(`${h}.${p}`))
  return { ok, alg: header.alg, claims: JSON.parse(Buffer.from(p, 'base64url')) }
}

// ---- helpers ----
const pkce = () => {
  const verifier = b64u(randomBytes(32))
  return { verifier, challenge: b64u(sha256(verifier)) }
}
async function authorize(client, extra = {}, { cookie = cfg.cookie } = {}) {
  const u = new URL(disc.authorization_endpoint)
  const params = { client_id: client.id, redirect_uri: client.redirectUri, response_type: 'code', scope: 'openid email profile', state: 'st-1', nonce: 'nonce-1', ...extra }
  for (const [k, v] of Object.entries(params)) if (v !== null) u.searchParams.set(k, v)
  const res = await fetch(u, { redirect: 'manual', headers: cookie ? { cookie } : {} })
  const loc = res.headers.get('location')
  return { status: res.status, loc: loc ? new URL(loc, u) : null }
}
const atApp = (r, client) => r.loc && `${r.loc.origin}${r.loc.pathname}` === client.redirectUri
async function token(client, form, { auth = 'post' } = {}) {
  const body = new URLSearchParams({ grant_type: 'authorization_code', redirect_uri: client.redirectUri, ...form })
  const headers = { 'content-type': 'application/x-www-form-urlencoded' }
  if (auth === 'basic') headers.authorization = `Basic ${Buffer.from(`${encodeURIComponent(client.id)}:${encodeURIComponent(client.secret)}`).toString('base64')}`
  else {
    body.set('client_id', client.id)
    body.set('client_secret', client.secret)
  }
  const res = await fetch(disc.token_endpoint, { method: 'POST', headers, body })
  return { status: res.status, body: await res.json().catch(() => null) }
}
async function codeFor(client, extra = {}) {
  const p = pkce()
  const r = await authorize(client, { code_challenge: p.challenge, code_challenge_method: 'S256', ...extra })
  return { code: atApp(r, client) ? r.loc.searchParams.get('code') : null, verifier: p.verifier, r }
}

// ---- the flow ----
const a = await codeFor(A)
check('signed in: a code with no page', !!a.code, a.r.loc?.toString().slice(0, 120))
check('state returned', a.r.loc?.searchParams.get('state') === 'st-1')
check('iss returned (RFC 9207)', a.r.loc?.searchParams.get('iss') === cfg.issuer, a.r.loc?.searchParams.get('iss') ?? 'absent')
const t = await token(A, { code: a.code, code_verifier: a.verifier }, { auth: 'basic' })
check('token exchange (client_secret_basic)', t.status === 200 && t.body?.id_token, `${t.status} ${JSON.stringify(t.body?.error ?? '')}`)
if (t.body?.id_token) {
  const v = await verifyJwt(t.body.id_token)
  const c = v.claims ?? {}
  check(`id_token signature (${v.alg})`, v.ok, v.why)
  check('id_token iss / aud / nonce', c.iss === cfg.issuer && (c.aud === A.id || (Array.isArray(c.aud) && c.aud.includes(A.id))) && c.nonce === 'nonce-1', JSON.stringify({ iss: c.iss, aud: c.aud, nonce: c.nonce }))
  check('id_token exp in the future, ≤ 1 day', c.exp > Date.now() / 1000 && c.exp - Date.now() / 1000 <= 86400, String(c.exp))
  check('id_token email verified', typeof c.email === 'string' && c.email_verified === true, `${c.email} ${c.email_verified}`)
  check('id_token auth_time', typeof c.auth_time === 'number')
  const ui = await fetch(disc.userinfo_endpoint, { headers: { authorization: `Bearer ${t.body.access_token}` } })
  const uj = await ui.json().catch(() => null)
  check('userinfo sub matches', ui.status === 200 && uj?.sub === c.sub, `${ui.status}`)
  const uiWithId = await fetch(disc.userinfo_endpoint, { headers: { authorization: `Bearer ${t.body.id_token}` } })
  check('userinfo refuses an ID token as access token', uiWithId.status === 401, String(uiWithId.status))
}
const replay = await token(A, { code: a.code, code_verifier: a.verifier })
check('code replay refused', replay.status === 400 && replay.body?.error === 'invalid_grant', `${replay.status} ${replay.body?.error}`)

const silent = await codeFor(A, { prompt: 'none' })
check('prompt=none with a session: a code', !!silent.code)
const anon = await authorize(A, { prompt: 'none', ...(({ challenge }) => ({ code_challenge: challenge, code_challenge_method: 'S256' }))(pkce()) }, { cookie: '' })
check('prompt=none without a session: login_required to the app', atApp(anon, A) && anon.loc.searchParams.get('error') === 'login_required', anon.loc?.toString().slice(0, 140) ?? String(anon.status))
const anonInteractive = await authorize(A, (({ challenge }) => ({ code_challenge: challenge, code_challenge_method: 'S256' }))(pkce()), { cookie: '' })
check('no session: to a login page, not the app', anonInteractive.status >= 300 && anonInteractive.status < 400 && !atApp(anonInteractive, A), anonInteractive.loc?.pathname ?? String(anonInteractive.status))

const wrongVerifier = await codeFor(A)
const wv = await token(A, { code: wrongVerifier.code, code_verifier: pkce().verifier })
check('wrong PKCE verifier refused', wv.status === 400 && wv.body?.error === 'invalid_grant', `${wv.status} ${wv.body?.error}`)
const noVerifier = await codeFor(A)
const nv = await token(A, { code: noVerifier.code })
check('missing PKCE verifier refused', nv.status === 400, `${nv.status} ${nv.body?.error}`)
const noPkce = await authorize(A, {})
check('authorize without PKCE refused', !(atApp(noPkce, A) && noPkce.loc.searchParams.get('code')), noPkce.loc?.searchParams.get('error') ?? String(noPkce.status))
const plain = await authorize(A, { code_challenge: 'x'.repeat(43), code_challenge_method: 'plain' })
check('plain PKCE refused', !(atApp(plain, A) && plain.loc.searchParams.get('code')), plain.loc?.searchParams.get('error') ?? String(plain.status))
const badRedirectCode = await codeFor(A)
const br = await token(A, { code: badRedirectCode.code, code_verifier: badRedirectCode.verifier, redirect_uri: `${A.redirectUri}/` })
check('token redirect_uri mismatch refused', br.status === 400, `${br.status} ${br.body?.error}`)
const badSecret = await token({ ...A, secret: 'wrong' }, { code: 'x', code_verifier: pkce().verifier })
check('bad client secret refused', badSecret.status === 401 || badSecret.body?.error === 'invalid_client', `${badSecret.status} ${badSecret.body?.error}`)

for (const [label, uri] of [['trailing slash', `${A.redirectUri}/`], ['extra query', `${A.redirectUri}?x=1`], ['other host', 'https://evil.example/cb']]) {
  const r = await authorize({ ...A, redirectUri: uri }, (({ challenge }) => ({ code_challenge: challenge, code_challenge_method: 'S256' }))(pkce()))
  const leaked = r.loc && r.loc.toString().startsWith(uri.split('?')[0]) && (r.loc.searchParams.has('code') || r.loc.searchParams.has('error'))
  check(`unregistered redirect (${label}) never redirected to`, !leaked, `${r.status} ${r.loc?.toString().slice(0, 80) ?? ''}`)
}
const unknown = await authorize({ ...A, id: 'no-such-client' }, (({ challenge }) => ({ code_challenge: challenge, code_challenge_method: 'S256' }))(pkce()))
check('unknown client never redirected to the app', !atApp(unknown, A), String(unknown.status))

if (B) {
  const b = await codeFor(B)
  check('second client: a code with no page (zero tap)', !!b.code)
  const stolen = await codeFor(A)
  const cross = await token(B, { code: stolen.code, code_verifier: stolen.verifier, redirect_uri: A.redirectUri })
  check("client B can't redeem A's code", cross.status === 400, `${cross.status} ${cross.body?.error}`)
  const after = await token(A, { code: stolen.code, code_verifier: stolen.verifier })
  check('… and the attempt spent it', after.status === 400, `${after.status} ${after.body?.error}`)
}

let failed = 0
for (const r of results) {
  if (!r.ok) failed++
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok || !r.detail ? '' : `  (${r.detail})`}`)
}
console.log(`\n${cfg.issuer}: ${results.length - failed}/${results.length} passed`)
process.exit(failed ? 1 : 0)
