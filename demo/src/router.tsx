/** A ~30-line router. Four routes don't justify a dependency. */
import { type ReactNode, createContext, useCallback, useContext, useEffect, useState } from 'react'

const NavContext = createContext<(to: string) => void>(() => {})

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
    setPath(new URL(to, window.location.origin).pathname)
    window.scrollTo(0, 0)
  }, [])
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
