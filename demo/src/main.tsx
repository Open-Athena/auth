import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { bootSessionLog } from '@open-athena/auth/session-log/client'
import '@open-athena/auth/react/session-log.css'
import { App } from './App.js'
import './styles.scss'

// One request per page load while the session log is off; the logger itself
// is a separate chunk, fetched only when a staff member has switched it on.
void bootSessionLog({ build: import.meta.env.VITE_BUILD_SHA ?? 'dev' })

// `retry: false` throughout: a 401 from a gated endpoint is an answer, not a
// transient failure, and retrying it just delays the wall.
const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 5000 } } })

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={client}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
)
