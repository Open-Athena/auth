/** JSON contracts shared by the route implementation and framework-free client. */
import type { Grant, NewGrant, GrantPatch, Subject } from './types.js';
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
/** One login a browser holds, in a gate's retained mode. Display only: `id` selects it, and is no credential. */
export interface AccountView {
    id: string;
    /** A verified email sign-in, or a share link (`grant`): never shown as each other. */
    kind: 'sso' | 'grant';
    email: string | null;
    /** A share link's memo. */
    name: string | null;
    subject: Subject | null;
    active: boolean;
    /** When this login stops working here (epoch s). */
    expiresAt: number;
}
/** A share link opened while another login was active, held for the person to switch to. */
export interface IncomingView {
    id: string;
    name: string | null;
    email: string | null;
    subject: Subject | null;
    /** When the offer lapses (epoch s); the link must be opened again after. */
    expiresAt: number;
}
/** `GET <base>/accounts` and the account mutations. `selection` goes back as `X-OA-Selection-Context`. */
export interface AccountsResponse {
    selection: string;
    active: string | null;
    accounts: AccountView[];
    incoming: IncomingView[];
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
    accounts: AccountsResponse;
    revoke: OkResponse;
    disable: OkResponse;
    enable: OkResponse;
    rotate: RotateResponse;
    activity: GrantActivity;
    log: LogResponse;
}
