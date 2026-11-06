import type { ProviderClient } from './routes.js';
export interface RegisteredClient {
    id: string;
    /** For people: what this app is. */
    name: string;
    secretHash: string;
    redirectUris: string[];
    postLogoutRedirectUris: string[];
    /** Epoch s, or null while active. */
    disabledAt: number | null;
    createdAt: number;
    createdBy: string;
    updatedAt: number;
    updatedBy: string;
}
export type ClientAction = 'create' | 'update' | 'rotate' | 'disable' | 'enable';
/** One logged change. `detail` holds what changed, never a secret. */
export interface ClientEvent {
    clientId: string;
    action: ClientAction;
    actor: string;
    /** Epoch s. */
    at: number;
    detail: string | null;
}
export interface NewClient {
    id: string;
    name: string;
    secretHash: string;
    redirectUris: string[];
    postLogoutRedirectUris?: string[];
}
export interface ClientChanges {
    name: string;
    redirectUris: string[];
    postLogoutRedirectUris: string[];
}
export interface ClientRegistry {
    get(id: string): Promise<RegisteredClient | null>;
    list(): Promise<RegisteredClient[]>;
    /** False if the id is taken, by a disabled client too. */
    create(client: NewClient, actor: string): Promise<boolean>;
    /** This and the rest return false if there's no such client. */
    update(id: string, changes: ClientChanges, actor: string): Promise<boolean>;
    rotate(id: string, secretHash: string, actor: string): Promise<boolean>;
    setDisabled(id: string, disabled: boolean, actor: string): Promise<boolean>;
    /** Newest first. */
    events(limit?: number): Promise<ClientEvent[]>;
}
/** For `ProviderOptions.lookupClient`: active clients only, so disabling cuts off the next request. */
export declare const clientLookup: (registry: Pick<ClientRegistry, "get">) => (id: string) => Promise<ProviderClient | null>;
/** A new client secret: 256 random bits. Show it once; store `hashClientSecret(secret)`. */
export declare const mintClientSecret: () => string;
/** What's wrong with this client id, or null. */
export declare const clientIdProblem: (id: string) => string | null;
/**
 * What's wrong with this callback URL for a client registered at runtime, or
 * null. Stricter than the provider, which only needs an exact match: https
 * under one of `domains`, or loopback for local development. This is the limit
 * on what a stolen admin session can do. Must already be in normal form,
 * because the provider compares it exactly with what the app sends.
 */
export declare function redirectUriProblem(raw: string, domains: string[]): string | null;
