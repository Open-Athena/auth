import type { ReactElement } from 'react'
import { Admin } from './pages/Admin.js'
import { Dashboard } from './pages/Dashboard.js'
import { Home } from './pages/Home.js'
import { Privacy } from './pages/Privacy.js'
import { Link, Router, usePath } from './router.js'

const ROUTES: Record<string, () => ReactElement> = {
  '/': Home,
  '/dashboard': Dashboard,
  '/admin': Admin,
  '/privacy': Privacy,
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
