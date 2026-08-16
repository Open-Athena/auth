import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.js'
import './styles.scss'

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
