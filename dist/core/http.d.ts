/** JSON contracts shared by the route implementation and framework-free client. */
import type { Grant, NewGrant, GrantPatch } from './types.js';
import type { GrantActivity, StoredEvent } from './store.js';
import type { Whoami } from '../client/identity.js';
export type { Grant, Subject } from './types.js';
export type { GrantActivity, StoredEvent, AllowEntry } from './store.js';
export type { Whoami } from '../client/identity.js';
export interface MintInput extends Omit<NewGrant, 'subject' | 'createdBy' | 'expiresAt'> {
    subjectName?: string;
    /** Avatar reference copied by the server; null suppresses the default Gravatar. */
    avatar?: string | null;
    expiresInS?: number | null;
    allowlist?: boolean;
}
export interface GrantUpdateInput extends Omit<GrantPatch, 'subject'> {
    subjectName?: string | null;
    avatar?: string | null;
    /** With a non-null `email`: also put that address on the allowlist, as minting with `allowlist: true` does. */
    allowlist?: boolean;
}
export interface AllowedForLink {
    email: string;
    status: 'added' | 'widened' | 'already';
}
export interface MintResponse {
    grant: Grant;
    token: string;
    allowed?: AllowedForLink;
}
export interface UpdateResponse {
    grant: Grant;
    allowed?: AllowedForLink;
}
export interface GrantsResponse {
    grants: Grant[];
}
export interface GrantResponse {
    grant: Grant;
}
export interface OkResponse {
    ok: boolean;
}
export interface RotateInput {
    endSessions?: boolean;
}
export interface RotateResponse {
    id: string;
    token: string;
}
export interface GrantListInput {
    active?: boolean;
}
export interface LogInput {
    grant?: string;
    limit?: number;
}
export interface LogResponse {
    events: StoredEvent[];
}
/** A route's successful response, used to check both ends of the wire. */
export interface AuthResponses {
    whoami: Whoami;
    logout: OkResponse;
    mint: MintResponse;
    list: GrantsResponse;
    update: UpdateResponse;
    revoke: OkResponse;
    disable: OkResponse;
    enable: OkResponse;
    rotate: RotateResponse;
    activity: GrantActivity;
    log: LogResponse;
}
