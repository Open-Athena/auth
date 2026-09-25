import { type Whoami, WhoamiChip, useWhoami } from '@open-athena/auth/react'
import type { ReactElement } from 'react'
import { VIEW_SOURCE } from './api.js'
import { Admin } from './pages/Admin.js'
import { Dashboard } from './pages/Dashboard.js'
import { Home } from './pages/Home.js'
import { Privacy } from './pages/Privacy.js'
import { Profile } from './pages/Profile.js'
import { Link, Router, useNavigate, usePath } from './router.js'

const ROUTES: Record<string, () => ReactElement> = {
  '/': Home,
  '/dashboard': Dashboard,
  '/admin': Admin,
  '/privacy': Privacy,
  '/profile': Profile,
}

export function App() {
  const [path, navigate] = usePath()
  const Page = ROUTES[path] ?? NotFound

  return (
    <Router navigate={navigate}>
      <nav className="nav">
        <Link to="/" className="brand">
          <code>@open-athena/auth</code>
        </Link>
        <div className="nav-links">
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
  if (!whoami) return null
  return (
    <WhoamiChip
      whoami={whoami}
      avatar
      logoutEndpoint="/api/view/logout"
      // Only an email session owns a profile row; a link session is the link's.
      onOpenProfile={whoami.kind === 'sso' ? () => navigate('/profile') : undefined}
      classNames={{ root: 'chip', name: 'chip-name', button: 'btn small', avatar: 'avatar', identity: 'chip-identity' }}
    />
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
