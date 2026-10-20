import type { Whoami } from '@open-athena/auth/client'
import { displayName } from '@open-athena/auth/client'

export const endpoint = '/api/view'
export const source = { endpoint: `${endpoint}/whoami` }
export const exchange = { endpoint: `${endpoint}/exchange` }

export function identityLabel(whoami: Whoami): string {
  return displayName(whoami) ?? 'Anonymous link'
}

export function linkFor(named: boolean): string {
  const next = location.pathname.replace(/\/$/, '') || '/'
  return `/api/demo-link?${new URLSearchParams({ named: named ? '1' : '0', next })}`
}

/** Static shared chrome; framework runtimes mount only inside the example. */
export function mountShell(framework: string): HTMLElement {
  const root = document.getElementById('root')!
  root.innerHTML = `
    <nav class="nav" aria-label="Main navigation">
      <a class="brand" href="/"><code>@open-athena/auth</code></a>
      <div class="nav-links">
        <a href="/vanilla">Vanilla</a><a href="/vue">Vue</a><a href="/react">React</a>
        <a href="/dashboard">Dashboard</a><a href="/admin">Admin</a>
        <a href="https://github.com/Open-Athena/auth">GitHub</a>
      </div>
    </nav>
    <main class="examples">
      <header class="example-intro">
        <h1>@open-athena/auth</h1>
        <p class="lede">An auth wall. A link that lets you through.</p>
        <p class="muted">Named share links, Google sign-in, email codes, and revocable access.</p>
      </header>
      <nav class="framework-tabs" aria-label="Framework examples">
        <a href="/vanilla">Vanilla JS</a><a href="/vue">Vue</a><a href="/react">React</a>
      </nav>
      <section class="example-stage" aria-label="Live auth example">
        <p class="example-caption"></p>
        <div id="example"></div>
      </section>
      <section class="example-more">
        <h2>One gate, more ways in</h2>
        <p><a href="/dashboard">Google or an emailed code</a> · <a href="/admin">Mint and revoke links</a></p>
        <p class="muted small">The library also handles approval queues, email notifications, allowlists, and access logs.</p>
        <a href="https://github.com/Open-Athena/auth#readme">Documentation and source</a>
      </section>
    </main>
    <footer><p class="muted small">Demo content only. Access to gated pages is logged. <a href="/privacy">Privacy</a></p></footer>`
  root.querySelector('.example-caption')!.textContent = framework
  for (const anchor of root.querySelectorAll<HTMLAnchorElement>('.framework-tabs a')) {
    if (anchor.pathname === location.pathname || (location.pathname === '/' && anchor.pathname === '/vanilla')) {
      anchor.setAttribute('aria-current', 'page')
    }
  }
  return document.getElementById('example')!
}

export function trackView(): void {
  void fetch(`${endpoint}/track`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: location.pathname }), keepalive: true,
  }).catch(() => {})
}
