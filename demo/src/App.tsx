import { AccountSwitcher, type Whoami, WhoamiChip, useAccounts, useWhoami } from '@open-athena/auth/react'
import type { ReactElement } from 'react'
import { VIEW_SOURCE } from './api.js'
import { Admin } from './pages/Admin.js'
import { Dashboard } from './pages/Dashboard.js'
import { Home } from './pages/Home.js'
import { Privacy } from './pages/Privacy.js'
import { AddAccount } from './pages/AddAccount.js'
import { Profile } from './pages/Profile.js'
import { Sessions } from './pages/Sessions.js'
import { Link, Router, useNavigate, usePath } from './router.js'

const ROUTES: Record<string, () => ReactElement> = {
  '/': Home,
  '/dashboard': Dashboard,
  '/admin': Admin,
  '/privacy': Privacy,
  '/profile': Profile,
  '/signin': AddAccount,
}

export function App() {
  const [path, navigate] = usePath()
  const Page = ROUTES[path] ?? (path === '/admin/sessions' || path.startsWith('/admin/sessions/') ? Sessions : NotFound)

  return (
    <Router navigate={navigate}>
      <nav className="nav">
        <Link to="/" className="brand">
          <code>@open-athena/auth</code>
        </Link>
        <div className="nav-links">
          <a href="/vanilla">Vanilla</a>
          <a href="/vue">Vue</a>
          <a href="/react">React</a>
          <Link to="/dashboard" className={path === '/dashboard' ? 'on' : ''}>
            Dashboard
          </Link>
          <Link to="/admin" className={path === '/admin' ? 'on' : ''}>
            Admin
          </Link>
          <a href="https://github.com/Open-Athena/auth">GitHub</a>
          <NavChip />
        </div>
      </nav>
      <main>
        <Page />
      </main>
      <footer>
        <p className="muted small">
          A demo. Nothing behind the gate is real; the gate is. Access to the gated page is logged — that's the point. <Link to="/privacy">Privacy</Link>
        </p>
      </footer>
    </Router>
  )
}

/**
 * Who this browser is, on every page: the view gate's session, whichever door
 * it came through. No `onSignedOut` on purpose: forgetting the identity is the
 * hook's job, and an app-side refresh here would mask a regression in it.
 */
function NavChip() {
  const navigate = useNavigate()
  const { whoami } = useWhoami<Whoami>(VIEW_SOURCE)
  if (!whoami) return <Accounts />
  return (
    <>
      <Accounts />
      <WhoamiChip
      whoami={whoami}
      avatar
      logoutEndpoint="/api/view/logout"
      // Only an email session owns a profile row; a link session is the link's.
      onOpenProfile={whoami.kind === 'sso' ? () => navigate('/profile') : undefined}
      classNames={{ root: 'chip', name: 'chip-name', button: 'btn small', avatar: 'avatar', identity: 'chip-identity' }}
      />
    </>
  )
}

/**
 * The browser's other logins (the dashboard gate retains several): a quiet
 * menu that only appears once there's something to switch to, or a share link
 * waiting to be used. One account looks exactly as it did before.
 */
function Accounts() {
  const { accounts } = useAccounts({ basePath: '/api/view' })
  if (!accounts || (accounts.accounts.length < 2 && !accounts.incoming.length)) return null
  const waiting = accounts.incoming.length
  return (
    <details className="accounts-menu">
      <summary className="btn small">
        Accounts · {accounts.accounts.length}
        {waiting > 0 && <span className="badge"> +{waiting}</span>}
      </summary>
      <AccountSwitcher
        basePath="/api/view"
        addAccountHref="/signin"
        onChanged={() => document.querySelector<HTMLDetailsElement>('.accounts-menu')?.removeAttribute('open')}
        classNames={{
          root: 'accounts',
          list: 'accounts-list',
          item: 'account',
          active: 'on',
          switch: 'account-switch',
          remove: 'btn small account-remove',
          tag: 'tag soft',
          incoming: 'account incoming',
          actions: 'accounts-actions',
          button: 'btn small',
          error: 'err',
        }}
      />
    </details>
  )
}

function NotFound() {
  return (
    <div className="prose">
      <h1>Not found</h1>
      <p>
        <Link to="/">Back to the start</Link>
      </p>
    </div>
  )
}
