import { type GrantsPanelProps } from './Grants.js';
import { type UserMenuProps } from './UserMenu.js';
export interface Mounted<P> {
    /** Merge in new props and re-render. */
    update: (props: Partial<P>) => void;
    unmount: () => void;
}
export interface MountUserMenuProps extends Omit<UserMenuProps, 'whoami' | 'client'> {
    /** The auth routes' base path (default `/api/auth`). */
    basePath?: string;
}
export interface MountGrantsPanelProps extends Omit<GrantsPanelProps, 'client' | 'controller'> {
    /** The auth routes' base path (default `/api/auth`). */
    basePath?: string;
}
/** Mount `<UserMenu>`, which fetches its own identity from `<basePath>/whoami`. Include `@open-athena/auth/react/ui.css`. */
export declare function mountUserMenu(element: Element, props?: MountUserMenuProps): Mounted<MountUserMenuProps>;
/** Mount `<GrantsPanel>`. Include `@open-athena/auth/react/ui.css`. */
export declare function mountGrantsPanel(element: Element, props: MountGrantsPanelProps): Mounted<MountGrantsPanelProps>;
