import { AuthClientError, createAuthClient, exchangeKeyParam, type Whoami } from '@open-athena/auth/client'
import { endpoint, exchange, identityLabel, linkFor, mountShell, trackView } from './shell.js'

const host = mountShell('Vanilla JS · @open-athena/auth/client')
const client = createAuthClient({ basePath: endpoint })
let version = 0
let signingOut = false

function button(label: string, action: () => void): HTMLButtonElement {
  const node = document.createElement('button')
  node.className = 'btn'
  node.textContent = label
  node.onclick = action
  return node
}

function render(whoami: Whoami | null): void {
  host.replaceChildren()
  const heading = document.createElement('h2')
  heading.textContent = whoami ? "You're in." : 'Private workspace'
  host.appendChild(heading)
  if (whoami) {
    const name = document.createElement('p')
    name.className = 'example-identity'
    name.textContent = identityLabel(whoami)
    if (whoami.subject?.avatar) {
      const avatar = document.createElement('img')
      avatar.src = whoami.subject.avatar
      avatar.alt = ''
      avatar.width = avatar.height = 40
      avatar.referrerPolicy = 'no-referrer'
      avatar.onerror = () => avatar.remove()
      name.insertBefore(avatar, name.firstChild)
    }
    const subject = document.createElement('code')
    subject.textContent = whoami.kind === 'grant' ? `g:${whoami.id}` : `e:${whoami.email}`
    const content = document.createElement('div')
    content.className = 'placeholder'
    content.textContent = 'Your private workspace'
    for (const node of [name, subject, content, button('Sign out', () => void signOut())]) host.appendChild(node)
  } else {
    const note = document.createElement('p')
    note.className = 'muted'
    note.textContent = 'Open a demo link to enter. No account needed.'
    const links = document.createElement('div')
    links.className = 'wall-actions'
    for (const [named, label] of [[true, 'Open named link'], [false, 'Open anonymous link']] as const) {
      const anchor = document.createElement('a')
      anchor.className = named ? 'btn primary' : 'btn'
      anchor.href = linkFor(named)
      anchor.textContent = label
      links.appendChild(anchor)
    }
    host.appendChild(note)
    host.appendChild(links)
  }
}

function showError(): void {
  host.replaceChildren()
  const error = document.createElement('p')
  error.setAttribute('role', 'alert')
  error.textContent = 'Could not check access. Please try again.'
  host.appendChild(error)
  host.appendChild(button('Try again', () => void refresh()))
}

async function refresh(): Promise<void> {
  if (signingOut) return
  const request = ++version
  host.textContent = 'Checking access…'
  try {
    const identity = await client.whoami()
    if (request === version) render(identity)
  } catch (error) {
    if (request !== version) return
    if (error instanceof AuthClientError && [401, 403].includes(error.status)) render(null)
    else showError()
  }
}

async function signOut(): Promise<void> {
  if (signingOut) return
  signingOut = true
  ++version
  const control = host.querySelector('button')!
  control.disabled = true
  try {
    await client.logout()
    render(null)
  } catch {
    control.disabled = false
    const error = document.createElement('p')
    error.setAttribute('role', 'alert')
    error.textContent = 'Could not sign out. Please try again.'
    host.appendChild(error)
  } finally {
    signingOut = false
  }
}

host.textContent = 'Checking access…'
void (async () => {
  await exchangeKeyParam(exchange)
  await refresh()
  trackView()
  window.addEventListener('focus', () => void refresh())
})()
