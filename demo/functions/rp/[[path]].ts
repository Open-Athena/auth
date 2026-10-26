/**
 * "App B": a second app that signs in only through the demo's broker
 * (`/oidc`), with its own gate and cookie. Server-rendered on purpose: it
 * shares no code or state with the dashboard's SPA, the way a separate OA
 * service wouldn't.
 *
 *   GET  /rp            -> who App B thinks you are, and the ways to sign in
 *   GET  /rp/start      -> `oidcStart` (`?prompt=none` silent, `?account=choose` chooser)
 *   GET  /rp/callback   -> `oidcCallback`: verify the broker's ID token, sign in to App B
 *   POST /rp/logout     -> sign out of App B only
 */
import { oidcCallback, oidcStart } from '@open-athena/auth/oidc'
import { type BrokerEnv, broker } from '../_lib/broker.js'

const MESSAGES: Record<string, string> = {
  login_required: "The silent attempt came back empty: you're not signed in at the broker. Sign in there, then App B needs no page at all.",
  access_denied: 'The broker refused this account for App B.',
  error: 'The broker returned an error.',
}

const esc = (s: string) => s.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`)

function page(who: string | null, sso: string | null): string {
  const note = sso && !who ? `<p class="note" role="status">${esc(MESSAGES[sso] ?? MESSAGES.error!)}</p>` : ''
  const status = who
    ? `<p>Signed in to App B as <strong>${esc(who)}</strong>, vouched for by the broker's ID token.</p>`
    : '<p>Not signed in to App B.</p>'
  const actions = who
    ? `<form method="post" action="/rp/logout"><button>Sign out of App B</button></form>
       <a class="btn" href="/oidc/logout">Sign out at the broker</a>`
    : `<a class="btn primary" href="/rp/start?next=/rp">Sign in with the broker</a>
       <a class="btn" href="/rp/start?next=/rp&amp;prompt=none">Try silently (prompt=none)</a>
       <a class="btn" href="/rp/start?next=/rp&amp;account=choose">Choose an account</a>`
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>App B</title>
<style>
  :root { --bg: #fff; --fg: #1b1f24; --muted: #59636e; --line: #d1d9e0; --accent: #0969da; --note: #fff8c5; }
  @media (prefers-color-scheme: dark) { :root { --bg: #0d1117; --fg: #e6edf3; --muted: #9198a1; --line: #3d444d; --accent: #4493f8; --note: #3b2e00; } }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.5 system-ui, sans-serif; }
  main { max-width: 36rem; margin: 0 auto; padding: 2rem 16px; }
  h1 { font-size: 1.4rem; margin: 0 0 .25rem; }
  a { color: var(--accent); }
  .muted { color: var(--muted); font-size: .9rem; }
  .actions { display: flex; flex-wrap: wrap; gap: .5rem; margin: 1.25rem 0; }
  .btn, button { font: inherit; padding: .45rem .9rem; border: 1px solid var(--line); border-radius: 6px; background: none; color: var(--fg); text-decoration: none; cursor: pointer; }
  .btn.primary { color: #fff; }
  .primary { background: var(--accent); border-color: var(--accent); color: #fff; }
  form { display: contents; }
  .note { background: var(--note); padding: .6rem .8rem; border-radius: 6px; }
</style>
</head>
<body>
<main>
  <h1>App B</h1>
  <p class="muted">A second app with its own session, signing in only through this demo's OIDC broker (<a href="/.well-known/openid-configuration">discovery</a>). The broker's people are the dashboard's: sign in there once and App B needs no page in between.</p>
  ${note}
  ${status}
  <div class="actions">${actions}</div>
  <p class="muted"><a href="/dashboard">← the dashboard (the broker's own sign-in)</a></p>
</main>
</body>
</html>
`
}

export const onRequest = async ({ request, env }: { request: Request; env: BrokerEnv }): Promise<Response> => {
  const url = new URL(request.url)
  const { rpGate, rp } = await broker(env, request)
  switch (url.pathname.replace(/\/+$/, '')) {
    case '/rp': {
      const auth = await rpGate.authenticate(request, Date.now(), { logView: false })
      const who = auth?.kind === 'sso' ? auth.email : null
      return new Response(page(who, url.searchParams.get('sso')), {
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
      })
    }
    case '/rp/start':
      return oidcStart(rp)({ request })
    case '/rp/callback':
      return oidcCallback(rp)({ request })
    case '/rp/logout': {
      if (request.method !== 'POST') return new Response(null, { status: 405 })
      const headers = new Headers({ location: '/rp', 'cache-control': 'no-store' })
      for (const c of await rpGate.signOutCookies(request)) headers.append('set-cookie', c)
      return new Response(null, { status: 303, headers })
    }
    default:
      return new Response('not found\n', { status: 404 })
  }
}
