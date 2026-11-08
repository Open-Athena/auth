import { ActivityAdmin } from '@open-athena/auth/react/activity'
import '@open-athena/auth/react/activity.css'
import { type Whoami, useWhoami } from '@open-athena/auth/react'
import { Link } from '../router.js'

export function Activity() {
  const { whoami } = useWhoami<Whoami>({ endpoint: '/api/admin/whoami' })
  if (whoami === undefined) return <p>Checking staff access...</p>
  if (!whoami || (!whoami.scopes.includes('requests') && !whoami.scopes.includes('*'))) {
    return <p>Staff access required. <Link to="/admin">Admin</Link></p>
  }
  return <div className="sessions-page">
    <p><Link to="/admin">Admin</Link></p>
    <ActivityAdmin />
  </div>
}
