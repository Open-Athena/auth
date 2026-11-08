import { activityFeed, sessionLogActivity } from '@open-athena/auth/activity'
import { d1ActivityStore } from '@open-athena/auth/activity/d1'
import type { Env } from './gates.js'

/** Record-only demo feed. Apply migrations/activity before enabling this hook. */
export function demoActivity(env: Env) {
  const store = d1ActivityStore(env.DB)
  const feed = activityFeed({ store, kinds: { 'demo.mint': { record: 'count', notify: 'off' } } })
  const hooks = sessionLogActivity(feed, { actor: ({ who }) => {
    if (who.grantId) return { id: `grant:${who.grantId}`, name: who.subjectName ?? who.email ?? 'Unnamed recipient', via: 'grant' }
    return who.email ? { id: `email:${who.email}`, name: who.email, via: who.via } : null
  } })
  return { store, feed, hooks }
}
