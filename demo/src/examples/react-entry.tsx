import { createAuthClient, displayName, sessionLossMessage } from '@open-athena/auth/client'
import { Avatar, useWhoami, useKeyExchange, useForgetWhoami, type Whoami } from '@open-athena/auth/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { endpoint, exchange, linkFor, mountShell, source, trackView } from './shell.js'

const host = mountShell('React · @open-athena/auth/react')
const client = createAuthClient({ basePath: endpoint })

function Identity({ whoami }: { whoami: Whoami }) {
  const forget = useForgetWhoami()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  async function signOut() {
    setBusy(true)
    setError(false)
    try { await client.logout(); forget() } catch { setError(true) } finally { setBusy(false) }
  }
  return <>
    <h2>You're in.</h2>
    <p className="example-identity"><Avatar whoami={whoami} size={40} /><span>{displayName(whoami) ?? 'Anonymous link'}</span></p>
    <code>{whoami.kind === 'grant' ? `g:${whoami.id}` : `e:${whoami.email}`}</code>
    <div className="placeholder">Your private workspace</div>
    <button className="btn" disabled={busy} onClick={() => void signOut()}>Sign out</button>
    {error && <p role="alert">Could not sign out. Please try again.</p>}
  </>
}

function Example() {
  const ready = useKeyExchange(exchange)
  const { whoami, error, refresh, reason } = useWhoami(source, { enabled: ready })
  if (!ready || whoami === undefined) return <p>Checking access…</p>
  if (error) return <><p role="alert">Could not check access. Please try again.</p><button className="btn" onClick={refresh}>Try again</button></>
  if (whoami) return <Identity whoami={whoami} />
  return <>
    <h2>Private workspace</h2>
    {reason && <p role="status">{sessionLossMessage(reason)}</p>}
    <p className="muted">Open a demo link to enter. No account needed.</p>
    <div className="wall-actions">
      <a className="btn primary" href={linkFor(true)}>Open named link</a>
      <a className="btn" href={linkFor(false)}>Open anonymous link</a>
    </div>
  </>
}

createRoot(host).render(<QueryClientProvider client={new QueryClient()}><Example /></QueryClientProvider>)
trackView()
