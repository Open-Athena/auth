import { type ClientRegistry } from './registry.js';
export type ManagementAction = 'read' | 'create' | 'update' | 'disable' | 'enable' | 'rotate';
export interface ClientCallbackPolicy {
    redirectUris: string[];
    postLogoutRedirectUris?: string[];
}
export interface ManagementPrincipal {
    actor: string;
    actions: ManagementAction[];
    clients: Record<string, ClientCallbackPolicy>;
}
/** Operator-issued capability. The bearer itself must have at least 256 random bits. */
export interface ManagementGrant extends ManagementPrincipal {
    tokenHash: string;
    expiresAt: number;
}
export interface ClientManagementOptions {
    registry: ClientRegistry;
    authorize: (request: Request) => Promise<ManagementPrincipal | Response>;
    redirectDomains: string[];
    reservedClientIds?: string[];
    basePath?: string;
}
/** Hash-only configuration; no cookies, OAuth access tokens or implicit admin access. */
export declare function managementTokenAuth(grants: ManagementGrant[], { now }?: {
    now?: () => number;
}): (request: Request) => Promise<ManagementPrincipal | Response>;
/** Scoped operator API. It never generates, accepts or returns plaintext client secrets. */
export declare function clientManagementRoutes({ registry, authorize, redirectDomains, reservedClientIds, basePath }: ClientManagementOptions): (request: Request) => Promise<Response | null>;
