/**
 * login.oa.dev: OA's sign-in broker.
 *
 * An OIDC provider (`@open-athena/auth/provider`) for OA's own apps, over a
 * gate whose only way in is Google, restricted to the Workspace domain (the
 * id_token's `hd`, not just the address). One person per browser: picking a
 * different Google account is Google's chooser (`prompt=select_account`).
 *
 *   /.well-known/openid-configuration, /oidc/*  the provider
 *   /signin?next=/oidc/authorize?…               where the provider sends someone to sign in
 *   /signin/return?next=…                        back from Google: on to `next`, or why not
 *   /auth/google/{start,callback}                the Google flow
 *   /                                            who's signed in here; sign out
 *   /dev/signin                                  local dev only (`DEV_SIGNIN=1` and a loopback host)
 */
import { createGate, domainPolicy } from '@open-athena/auth'
import { d1AuditSink, d1GrantStore, d1ProfileStore } from '@open-athena/auth/d1'
import { oidcCallback, oidcStart } from '@open-athena/auth/oidc'
import { generateSigningKey, hashClientSecret, oidcProviderRoutes, type SigningJwk } from '@open-athena/auth/provider'
import { d1ProviderStore } from '@open-athena/auth/provider/d1'
import { clients } from './clients.js'

export interface Env {
  DB: D1Database
  WORKSPACE_DOMAIN: string
  SESSION_SECRET?: string
  /** A private RS256 JWK (JSON). */
  OIDC_SIGNING_KEY?: string
  GOOGLE_CLIENT_ID?: string
  GOOGLE_CLIENT_SECRET?: string
  /** `1` in `.dev.vars` only: a sign-in form that skips Google, on a loopback host. */
  DEV_SIGNIN?: string
}

const SCOPE = 'member'
const AUTHORIZE = '/oidc/authorize'

const isLoopback = (url: URL) => url.hostname === 'localhost' || url.hostname === '127.0.0.1'

let devKey: Promise<SigningJwk> | null = null

function config(env: Env, req: Request) {
  const url = new URL(req.url)
  const local = isLoopback(url)
  const secret = env.SESSION_SECRET ?? (local ? 'dev-only-insecure-secret-do-not-ship' : null)
  if (!secret) throw new Error('SESSION_SECRET is not configured')
  const key = env.OIDC_SIGNING_KEY
    ? Promise.resolve(JSON.parse(env.OIDC_SIGNING_KEY) as SigningJwk)
    : local
      ? (devKey ??= generateSigningKey('dev'))
      : null
  if (!key) throw new Error('OIDC_SIGNING_KEY is not configured')
  const gate = createGate({
    store: d1GrantStore(env.DB),
    audit: d1AuditSink(env.DB),
    profiles: d1ProfileStore(env.DB),
    secret,
    // `__Host-` needs Secure, which a plain-http dev server can't set.
    cookieName: url.protocol === 'https:' ? '__Host-oa_login' : 'oa_login',
    policy: domainPolicy([env.WORKSPACE_DOMAIN], [SCOPE]),
  })
  return { url, local, secret, key, gate }
}

const esc = (s: string) => s.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`)

function page(title: string, body: string, status = 200): Response {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · OA sign-in</title>
<style>
:root { color-scheme: light dark; --fg: #1a1a1a; --bg: #fafafa; --muted: #666; --accent: #2563eb; --card: #fff; --border: #ddd }
@media (prefers-color-scheme: dark) { :root { --fg: #eee; --bg: #121212; --muted: #999; --accent: #60a5fa; --card: #1e1e1e; --border: #333 } }
body { font: 16px/1.5 system-ui, sans-serif; color: var(--fg); background: var(--bg); margin: 0; display: grid; place-items: center; min-height: 100vh }
main { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 2rem; max-width: 26rem; margin: 1rem }
h1 { font-size: 1.25rem; margin: 0 0 1rem }
p { margin: 0.5rem 0 }
.muted { color: var(--muted) }
a, button.link { color: var(--accent) }
.actions { display: flex; gap: 1rem; flex-wrap: wrap; margin-top: 1.25rem; align-items: center }
.button, button { font: inherit; padding: 0.5rem 1rem; border-radius: 8px; border: 1px solid var(--border); background: var(--accent); color: #fff; text-decoration: none; cursor: pointer }
button.link { background: none; border: none; padding: 0; text-decoration: underline }
input { font: inherit; padding: 0.4rem; border-radius: 6px; border: 1px solid var(--border); background: var(--bg); color: var(--fg) }
</style>
</head>
<body><main><h1>${esc(title)}</h1>
${body}
</main></body>
</html>
`
  return new Response(html, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } })
}

const redirect = (to: string, cookies: string[] = []) => {
  const headers = new Headers({ location: to, 'cache-control': 'no-store' })
  for (const c of cookies) headers.append('set-cookie', c)
  return new Response(null, { status: 302, headers })
}

/** Only the provider's own authorize URL: `/signin` is not a general-purpose redirector. */
const authorizeNext = (raw: string | null): string | null => (raw?.startsWith(`${AUTHORIZE}?`) ? raw : null)

const SSO_MESSAGES: Record<string, string> = {
  access_denied: 'Google sign-in was cancelled.',
  login_required: 'Google needs you to sign in.',
  interaction_required: 'Google needs you to sign in.',
  consent_required: 'Google needs your consent.',
  account_selection_required: 'Google needs you to choose an account.',
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const { url, local, secret, key, gate } = config(env, req)
    const issuer = url.origin
    const devSignin = local && env.DEV_SIGNIN === '1'
    const provider = oidcProviderRoutes({
      gate,
      issuer,
      // Locally, a client to drive the flow by hand (its callback needn't exist:
      // the code is in the redirect's Location).
      clients: devSignin
        ? [...clients, { id: 'dev-rp', secretHash: await hashClientSecret('dev-rp-secret'), redirectUris: [`${issuer}/dev/callback`] }]
        : clients,
      keys: [await key],
      store: d1ProviderStore(env.DB),
      subjectSecret: secret,
      loginUrl: '/signin',
    })
    const fromProvider = await provider(req)
    if (fromProvider) return fromProvider

    const google = (authParams: Record<string, string> = {}) => {
      if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return null
      return {
        gate,
        clientId: env.GOOGLE_CLIENT_ID,
        clientSecret: env.GOOGLE_CLIENT_SECRET,
        redirectUri: `${issuer}/auth/google/callback`,
        hostedDomain: env.WORKSPACE_DOMAIN,
        authParams: { hd: env.WORKSPACE_DOMAIN, ...authParams },
      }
    }

    switch (url.pathname) {
      case '/signin': {
        const next = authorizeNext(url.searchParams.get('next'))
        if (!next) return page('Nothing to sign in to', '<p>This page is reached from an app\'s sign-in.</p>', 400)
        const back = `/signin/return?next=${encodeURIComponent(next)}`
        if (devSignin) return redirect(`/dev/signin?next=${encodeURIComponent(back)}`)
        if (!google()) return page('Sign-in is not configured', '<p class="muted">GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are not set.</p>', 503)
        const start = new URL('/auth/google/start', issuer)
        start.searchParams.set('next', back)
        const hint = url.searchParams.get('login_hint')
        if (hint) start.searchParams.set('login_hint', hint)
        // A forced sign-in or an account choice: Google's chooser either way.
        if (url.searchParams.has('prompt')) start.searchParams.set('account', 'choose')
        return redirect(`${start.pathname}${start.search}`)
      }
      case '/signin/return': {
        const next = authorizeNext(url.searchParams.get('next'))
        if (!next) return redirect('/')
        const sso = url.searchParams.get('sso')
        if (!sso) return redirect(next)
        // Back to the app with a standard error: the same request, silently,
        // which the provider answers with `login_required` and no page.
        const giveUp = new URL(next, issuer)
        giveUp.searchParams.set('prompt', 'none')
        return page(
          'Not signed in',
          `<p>${esc(SSO_MESSAGES[sso] ?? 'Google sign-in failed.')}</p>
<div class="actions"><a class="button" href="/signin?next=${esc(encodeURIComponent(next))}&amp;prompt=select_account">Try again</a><a href="${esc(`${giveUp.pathname}${giveUp.search}`)}">Back to the app</a></div>`,
        )
      }
      case '/auth/google/start':
      case '/auth/google/callback': {
        const cfg = google()
        if (!cfg) return page('Sign-in is not configured', '<p class="muted">GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are not set.</p>', 503)
        // An app's `login_hint`, passed on by `/signin`.
        const hint = url.searchParams.get('login_hint')
        const withHint = hint ? google({ login_hint: hint })! : cfg
        return url.pathname.endsWith('/start') ? oidcStart(withHint)({ request: req }) : oidcCallback(cfg)({ request: req })
      }
      case '/signout': {
        if (req.method !== 'POST') return redirect('/')
        return redirect('/', await gate.signOutCookies(req))
      }
      case '/dev/signin': {
        if (!devSignin) return new Response('not found\n', { status: 404 })
        const next = url.searchParams.get('next') ?? '/'
        const safe = next.startsWith('/') && !next.startsWith('//') ? next : '/'
        if (req.method === 'POST') {
          const email = String((await req.formData()).get('email') ?? '').trim().toLowerCase()
          const r = await gate.signIn(email, req)
          if (!r) return page('Refused', `<p>${esc(email)} isn't at ${esc(env.WORKSPACE_DOMAIN)}.</p>`, 403)
          return redirect(safe, r.cookies)
        }
        return page(
          'Dev sign-in',
          `<p class="muted">Local only: stands in for Google.</p>
<form method="post"><p><input name="email" type="email" required placeholder="you@${esc(env.WORKSPACE_DOMAIN)}" autofocus></p>
<div class="actions"><button>Sign in</button></div></form>`,
        )
      }
      case '/': {
        const auth = await gate.authenticate(req)
        const denied = url.searchParams.get('denied')
        const deniedNote = denied
          ? `<p>${esc(denied)} can't sign in here: only ${esc(env.WORKSPACE_DOMAIN)} Workspace accounts can.</p>`
          : ''
        if (auth?.kind === 'sso') {
          return page(
            'OA sign-in',
            `${deniedNote}<p>Signed in as <strong>${esc(auth.email)}</strong>.</p>
<p class="muted">OA apps sign you in through here.</p>
<form method="post" action="/signout" class="actions"><button>Sign out</button></form>`,
          )
        }
        const start = devSignin ? '/dev/signin?next=/' : '/auth/google/start?next=/&amp;account=choose'
        return page(
          'OA sign-in',
          `${deniedNote}<p class="muted">Not signed in.</p>
<div class="actions"><a class="button" href="${start}">Sign in with Google</a></div>`,
        )
      }
      default:
        return new Response('not found\n', { status: 404 })
    }
  },
} satisfies ExportedHandler<Env>
