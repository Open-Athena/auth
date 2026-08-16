import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render } from '@testing-library/react'
import type { ReactElement, ReactNode } from 'react'

/** Retries and caching across tests would make assertions depend on test order. */
export function renderWithQuery(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  return { client, ...render(ui, { wrapper }) }
}

export interface FetchCall {
  url: string
  method: string
  body: unknown
}

/** Replace `fetch` with a scripted responder, recording what was asked of it. */
export function stubFetch(routes: Record<string, { status: number; body?: unknown }>) {
  const calls: FetchCall[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const path = url.startsWith('http') ? new URL(url).pathname : url.split('?')[0]!
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : null })
    const route = routes[path]
    if (!route) return new Response('no route', { status: 500 })
    return new Response(route.body === undefined ? '' : JSON.stringify(route.body), {
      status: route.status,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
  return calls
}

/** Point jsdom at a URL without a real navigation. */
export function setLocation(href: string) {
  window.history.replaceState({}, '', href)
}
