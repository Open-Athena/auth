import { jsx as _jsx } from "react/jsx-runtime";
/**
 * Hosting a component in a page that isn't a React app (the transcripts hub's
 * Svelte SPA, say): React runs inside `element` only. Needs `react-dom` and,
 * since `UserMenu` is here, `@floating-ui/react`.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useMemo } from 'react';
import { createRoot } from 'react-dom/client';
import { createAuthClient } from '../client/api.js';
import { GrantsPanel } from './Grants.js';
import { UserMenu } from './UserMenu.js';
import { useWhoami } from './useWhoami.js';
function HostedUserMenu({ basePath = '/api/auth', ...props }) {
    const client = useMemo(() => createAuthClient({ basePath }), [basePath]);
    const { whoami } = useWhoami({ endpoint: `${client.basePath}/whoami` });
    return _jsx(UserMenu, { whoami: whoami, client: client, ...props });
}
function HostedGrantsPanel({ basePath = '/api/auth', ...props }) {
    const client = useMemo(() => createAuthClient({ basePath }), [basePath]);
    return _jsx(GrantsPanel, { client: client, ...props });
}
function mount(element, Component, initial) {
    const root = createRoot(element);
    const queryClient = new QueryClient();
    let props = initial;
    const render = () => root.render(_jsx(QueryClientProvider, { client: queryClient, children: _jsx(Component, { ...props }) }));
    render();
    return {
        update(next) {
            props = { ...props, ...next };
            render();
        },
        unmount: () => root.unmount(),
    };
}
/** Mount `<UserMenu>`, which fetches its own identity from `<basePath>/whoami`. Include `@open-athena/auth/react/ui.css`. */
export function mountUserMenu(element, props = {}) {
    return mount(element, HostedUserMenu, props);
}
/** Mount `<GrantsPanel>`. Include `@open-athena/auth/react/ui.css`. */
export function mountGrantsPanel(element, props) {
    return mount(element, HostedGrantsPanel, props);
}
