/**
 * `/admin`: the apps registered in this broker's D1 registry. Server-rendered
 * forms, for the named admins only (Workspace membership isn't enough). Every
 * change is logged, and a secret appears only in the response to the POST that
 * made it. `scripts/oa-client.mjs` does the same from a terminal.
 */
import type { Gate } from '@open-athena/auth'
import {
  clientIdProblem,
  type ClientRegistry,
  hashClientSecret,
  mintClientSecret,
  type ProviderClient,
  redirectUriProblem,
  type RegisteredClient,
} from '@open-athena/auth/provider'
import { esc, page, redirect } from './page.js'

export interface AdminOptions {
  gate: Gate
  registry: ClientRegistry
  /** Shown read-only, and their ids can't be taken. */
  staticClients: ProviderClient[]
  admins: Set<string>
  /** Callbacks must be https under one of these (or loopback). */
  redirectDomains: string[]
  /** Where to send someone not signed in. */
  signInPath: string
}

export const parseAdmins = (raw: string | undefined): Set<string> =>
  new Set((raw ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean))

/** What the person typed, to show again beside an error. */
interface Draft {
  id: string
  name: string
  redirects: string
  postLogouts: string
}

const lines = (raw: string): string[] => raw.split(/\s+/).filter(Boolean)
const when = (s: number) => `${new Date(s * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC`

function securityHeaders(nonce: string): Record<string, string> {
  return {
    'content-security-policy': `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`,
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
  }
}

const fields = (d: Pick<Draft, 'name' | 'redirects' | 'postLogouts'>) => `<label>Name<input name="name" required maxlength="100" value="${esc(d.name)}"></label>
<label>Callback URLs, one per line<textarea name="redirects" rows="2" required>${esc(d.redirects)}</textarea></label>
<label>After-logout URLs, one per line (optional)<textarea name="postLogouts" rows="1">${esc(d.postLogouts)}</textarea></label>`

function clientCard(c: RegisteredClient, draft: Draft | null): string {
  const d = draft ?? { id: c.id, name: c.name, redirects: c.redirectUris.join('\n'), postLogouts: c.postLogoutRedirectUris.join('\n') }
  const action = `/admin/clients/${encodeURIComponent(c.id)}`
  return `<div class="client">
<h3><code>${esc(c.id)}</code> <span>${esc(c.name)}</span>${c.disabledAt !== null ? ` <span class="tag">disabled ${esc(when(c.disabledAt))}</span>` : ''}</h3>
<p class="muted">${c.redirectUris.map(u => `<code>${esc(u)}</code>`).join('<br>')}</p>
<details${draft ? ' open' : ''}><summary>Edit</summary>
<form method="post" action="${esc(action)}">${fields(d)}<div class="actions"><button name="action" value="save">Save</button></div></form>
</details>
<div class="actions">
<form method="post" action="${esc(action)}"><button class="quiet" name="action" value="${c.disabledAt === null ? 'disable' : 'enable'}">${c.disabledAt === null ? 'Disable' : 'Enable'}</button></form>
<form method="post" action="${esc(action)}" class="actions" style="margin:0"><label class="check"><input type="checkbox" name="confirm" required> The old secret stops working now</label><button class="quiet" name="action" value="rotate">Rotate secret</button></form>
</div>
</div>`
}

export function adminRoutes({ gate, registry, staticClients, admins, redirectDomains, signInPath }: AdminOptions) {
  const staticIds = new Set(staticClients.map(c => c.id))

  async function listPage(actor: string, nonce: string, error: string | null = null, draft: Draft | null = null): Promise<Response> {
    const [clients, events] = await Promise.all([registry.list(), registry.events(30)])
    const editing = draft && clients.some(c => c.id === draft.id) ? draft : null
    const creating = draft && !editing ? draft : { id: '', name: '', redirects: '', postLogouts: '' }
    const body = `<p class="muted">Signed in as ${esc(actor)}. Callbacks must be https under ${esc(redirectDomains.join(', '))}, or loopback.</p>
${error ? `<div class="error" role="alert">${esc(error)}</div>` : ''}
${clients.map(c => clientCard(c, editing?.id === c.id ? editing : null)).join('\n') || '<p class="muted">None yet.</p>'}
${staticClients
  .map(
    c => `<div class="client"><h3><code>${esc(c.id)}</code> <span class="tag">in code</span></h3>
<p class="muted">${c.redirectUris.map(u => `<code>${esc(u)}</code>`).join('<br>')}</p></div>`,
  )
  .join('\n')}
<h2>Add an app</h2>
<form method="post" action="/admin/clients">
<label>Client id<input name="id" required maxlength="63" pattern="[a-z0-9-]+" value="${esc(creating.id)}"></label>
${fields(creating)}
<div class="actions"><button>Create</button></div>
</form>
<h2>Changes</h2>
${
  events.length
    ? `<div class="scroll"><table><thead><tr><th>When</th><th>App</th><th>Change</th><th>By</th><th>Callbacks</th></tr></thead><tbody>
${events
  .map(e => `<tr><td>${esc(when(e.at))}</td><td><code>${esc(e.clientId)}</code></td><td>${esc(e.action)}</td><td>${esc(e.actor)}</td><td>${e.detail ? `<code>${esc((JSON.parse(e.detail) as string[]).join(' '))}</code>` : ''}</td></tr>`)
  .join('\n')}
</tbody></table></div>`
    : '<p class="muted">None yet.</p>'
}
`
    return page('Registered apps', body, error ? 400 : 200, { wide: true, headers: securityHeaders(nonce) })
  }

  function secretPage(req: Request, id: string, secret: string, verb: string, nonce: string): Response {
    const issuer = new URL(req.url).origin
    return page(
      `${verb}: ${id}`,
      `<p><strong>Copy this secret now.</strong> It isn't stored and won't be shown again.</p>
<p><code id="secret">${esc(secret)}</code></p>
<div class="actions"><button id="copy" type="button">Copy</button><a href="/admin">Done</a></div>
<h2>In the app</h2>
<p class="muted">Issuer <code>${esc(issuer)}</code>, client id <code>${esc(id)}</code>, and the secret as a Worker secret:</p>
<p><code>wrangler secret put OA_LOGIN_CLIENT_SECRET</code></p>
<script nonce="${nonce}">
const b = document.getElementById('copy')
b.addEventListener('click', async () => {
  await navigator.clipboard.writeText(document.getElementById('secret').textContent)
  b.textContent = 'Copied'
})
</script>`,
      200,
      { wide: true, headers: securityHeaders(nonce) },
    )
  }

  /** The problem with this submission, or null. */
  function problem(d: Draft): string | null {
    if (!d.name.trim()) return 'Give it a name.'
    if (d.name.length > 100) return 'That name is too long.'
    const redirects = lines(d.redirects)
    if (!redirects.length) return 'Give it a callback URL.'
    for (const uri of [...redirects, ...lines(d.postLogouts)]) {
      const p = redirectUriProblem(uri, redirectDomains)
      if (p) return p
    }
    return null
  }

  return async (req: Request): Promise<Response | null> => {
    const url = new URL(req.url)
    const path = url.pathname
    if (path !== '/admin' && !path.startsWith('/admin/')) return null

    const nonce = crypto.randomUUID().replaceAll('-', '')
    const auth = await gate.authenticate(req)
    const email = auth?.kind === 'sso' ? auth.email.toLowerCase() : null
    if (!email) return req.method === 'GET' ? redirect(signInPath) : page('Not signed in', '<p><a href="/admin">Sign in</a></p>', 401)
    if (!admins.has(email)) return page('Not an admin', `<p>${esc(email)} can't manage apps here.</p>`, 403)

    if (req.method === 'GET') return path === '/admin' ? listPage(email, nonce) : new Response('not found\n', { status: 404 })
    if (req.method !== 'POST') return new Response('method not allowed\n', { status: 405, headers: { allow: 'GET, POST' } })
    // A cross-site form can carry the cookie, but not this origin.
    if (req.headers.get('origin') !== url.origin) return page('Refused', '<p>This form has to come from this site.</p>', 403)

    const form = await req.formData()
    const text = (k: string) => String(form.get(k) ?? '').trim()
    const draft: Draft = { id: text('id'), name: text('name'), redirects: text('redirects'), postLogouts: text('postLogouts') }

    if (path === '/admin/clients') {
      const idProblem = clientIdProblem(draft.id)
      const taken = staticIds.has(draft.id) || (await registry.get(draft.id)) !== null
      const wrong = idProblem ?? (taken ? `${draft.id} is taken.` : problem(draft))
      if (wrong) return listPage(email, nonce, wrong, draft)
      const secret = mintClientSecret()
      const created = await registry.create(
        { id: draft.id, name: draft.name, secretHash: await hashClientSecret(secret), redirectUris: lines(draft.redirects), postLogoutRedirectUris: lines(draft.postLogouts) },
        email,
      )
      if (!created) return listPage(email, nonce, `${draft.id} is taken.`, draft)
      return secretPage(req, draft.id, secret, 'Created', nonce)
    }

    const id = decodeURIComponent(path.slice('/admin/clients/'.length))
    if (!path.startsWith('/admin/clients/') || !(await registry.get(id))) return new Response('not found\n', { status: 404 })
    switch (text('action')) {
      case 'save': {
        const edit = { ...draft, id }
        const wrong = problem(edit)
        if (wrong) return listPage(email, nonce, wrong, edit)
        await registry.update(id, { name: edit.name, redirectUris: lines(edit.redirects), postLogoutRedirectUris: lines(edit.postLogouts) }, email)
        return redirect('/admin')
      }
      case 'rotate': {
        if (!form.get('confirm')) return listPage(email, nonce, `Tick the box to rotate ${id}'s secret.`)
        const secret = mintClientSecret()
        await registry.rotate(id, await hashClientSecret(secret), email)
        return secretPage(req, id, secret, 'Rotated', nonce)
      }
      case 'disable':
      case 'enable':
        await registry.setDisabled(id, text('action') === 'disable', email)
        return redirect('/admin')
      default:
        return new Response('unknown action\n', { status: 400 })
    }
  }
}
