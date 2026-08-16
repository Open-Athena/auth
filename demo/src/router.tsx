/** A ~30-line router. Four routes don't justify a dependency. */
import { type ReactNode, createContext, useCallback, useContext, useEffect, useState } from 'react'

const NavContext = createContext<(to: string) => void>(() => {})

/**
 * Tell the gate which route was actually viewed. A client-side navigation makes
 * no server request, so without this the log would show whatever API call
 * happened to fire — never the page the visitor read. Anonymous beacons are
 * dropped server-side, so this is a no-op for signed-out visitors.
 */
const beacon = (path: string): void => {
  void fetch('/api/view/track', {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path }),
    keepalive: true,
  }).catch(() => {})
}

export function useNavigate() {
  return useContext(NavContext)
}

export function usePath(): [string, (to: string) => void] {
  const [path, setPath] = useState(() => window.location.pathname)
  useEffect(() => {
    const onPop = () => setPath(window.location.pathname)
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])
  const navigate = useCallback((to: string) => {
    window.history.pushState({}, '', to)
    const next = new URL(to, window.location.origin).pathname
    setPath(next)
    window.scrollTo(0, 0)
    beacon(next)
  }, [])
  useEffect(() => beacon(window.location.pathname), [])
  return [path, navigate]
}

export function Router({ navigate, children }: { navigate: (to: string) => void; children: ReactNode }) {
  return <NavContext.Provider value={navigate}>{children}</NavContext.Provider>
}

export function Link({ to, children, className }: { to: string; children: ReactNode; className?: string }) {
  const navigate = useNavigate()
  return (
    <a
      href={to}
      className={className}
      onClick={e => {
        // Let modified clicks open a new tab, as a real link would.
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return
        e.preventDefault()
        navigate(to)
      }}
    >
      {children}
    </a>
  )
}
