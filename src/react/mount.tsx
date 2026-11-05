/**
 * Hosting a component in a page that isn't a React app (the transcripts hub's
 * Svelte SPA, say): React runs inside `element` only. Needs `react-dom` and,
 * since `UserMenu` is here, `@floating-ui/react`.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useMemo } from 'react'
import { createRoot } from 'react-dom/client'
import { createAuthClient } from '../client/api.js'
import { GrantsPanel, type GrantsPanelProps } from './Grants.js'
import { UserMenu, type UserMenuProps } from './UserMenu.js'
import { useWhoami } from './useWhoami.js'

export interface Mounted<P> {
  /** Merge in new props and re-render. */
  update: (props: Partial<P>) => void
  unmount: () => void
}

export interface MountUserMenuProps extends Omit<UserMenuProps, 'whoami' | 'client'> {
  /** The auth routes' base path (default `/api/auth`). */
  basePath?: string
}

export interface MountGrantsPanelProps extends Omit<GrantsPanelProps, 'client' | 'controller'> {
  /** The auth routes' base path (default `/api/auth`). */
  basePath?: string
}

function HostedUserMenu({ basePath = '/api/auth', ...props }: MountUserMenuProps) {
  const client = useMemo(() => createAuthClient({ basePath }), [basePath])
  const { whoami } = useWhoami({ endpoint: `${client.basePath}/whoami` })
  return <UserMenu whoami={whoami} client={client} {...props} />
}

function HostedGrantsPanel({ basePath = '/api/auth', ...props }: MountGrantsPanelProps) {
  const client = useMemo(() => createAuthClient({ basePath }), [basePath])
  return <GrantsPanel client={client} {...props} />
}

function mount<P extends object>(element: Element, Component: (props: P) => React.ReactNode, initial: P): Mounted<P> {
  const root = createRoot(element)
  const queryClient = new QueryClient()
  let props = initial
  const render = () =>
    root.render(
      <QueryClientProvider client={queryClient}>
        <Component {...props} />
      </QueryClientProvider>,
    )
  render()
  return {
    update(next) {
      props = { ...props, ...next }
      render()
    },
    unmount: () => root.unmount(),
  }
}

/** Mount `<UserMenu>`, which fetches its own identity from `<basePath>/whoami`. Include `@open-athena/auth/react/ui.css`. */
export function mountUserMenu(element: Element, props: MountUserMenuProps = {}): Mounted<MountUserMenuProps> {
  return mount(element, HostedUserMenu, props)
}

/** Mount `<GrantsPanel>`. Include `@open-athena/auth/react/ui.css`. */
export function mountGrantsPanel(element: Element, props: MountGrantsPanelProps): Mounted<MountGrantsPanelProps> {
  return mount(element, HostedGrantsPanel, props)
}
