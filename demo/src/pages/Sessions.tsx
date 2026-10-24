import { EMPTY_PARAMS, type SessionListParams, SessionList, SessionView } from '@open-athena/auth/react/session-log'
import { useEffect, useState } from 'react'
import { Link } from '../router.js'

/** `/admin/sessions` and `/admin/sessions/<sid>`: the session log's viewer (staff only; the API refuses anyone else). */
export function Sessions() {
  // `App` re-renders this on every navigation; the path is the browser's.
  const path = window.location.pathname
  const sid = path.startsWith('/admin/sessions/') ? decodeURIComponent(path.slice('/admin/sessions/'.length)) : null
  return (
    <div className="sessions-page">
      <p className="muted small">
        <Link to="/admin">admin</Link>
        {sid && (
          <>
            {' '}
            · <Link to="/admin/sessions">sessions</Link>
          </>
        )}
      </p>
      {sid ? (
        <SessionView sid={sid} />
      ) : (
        <>
          <h1>Sessions</h1>
          <ListWithUrlState />
        </>
      )}
    </div>
  )
}

/** The list's filters and page live in the URL (`u`, `since`, `err`, `after` / `before`), so a view can be shared. */
function ListWithUrlState() {
  const [search, setSearch] = useState(() => window.location.search)
  useEffect(() => {
    const onPop = () => setSearch(window.location.search)
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])
  const q = new URLSearchParams(search)
  const params: SessionListParams = {
    ...EMPTY_PARAMS,
    email: q.get('u') ?? '',
    since: q.get('since') ?? '',
    errors: q.get('err') === '1',
    after: q.get('after'),
    before: q.get('before'),
  }
  const onParams = (p: SessionListParams, { replace }: { replace: boolean }) => {
    const n = new URLSearchParams()
    if (p.email) n.set('u', p.email)
    if (p.since) n.set('since', p.since)
    if (p.errors) n.set('err', '1')
    if (p.after) n.set('after', p.after)
    else if (p.before) n.set('before', p.before)
    const next = n.size ? `?${n}` : ''
    // A filter edit replaces the entry; a page turn pushes one, so Back returns to the previous page.
    window.history[replace ? 'replaceState' : 'pushState']({}, '', `/admin/sessions${next}`)
    setSearch(next)
  }
  return (
    <SessionList
      params={params}
      onParams={onParams}
      sessionHref={sid => `/admin/sessions/${encodeURIComponent(sid)}`}
      renderLink={({ href, className, children }) => (
        <Link to={href} className={className}>
          {children}
        </Link>
      )}
    />
  )
}
