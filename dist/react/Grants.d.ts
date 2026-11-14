import { type ReactNode } from 'react';
import type { AuthClient } from '../client/api.js';
import type { GrantsController } from '../client/grants.js';
import type { Grant, MintInput } from '../core/http.js';
import { type AvatarFieldProps } from './AvatarField.js';
import { type UseGrantsResult } from './useGrants.js';
/** A scope an app offers on its links. `hint` is where to explain a consequence. */
export interface GrantScope {
    id: string;
    label: ReactNode;
    hint?: ReactNode;
}
declare const DEFAULT_CLASSES: {
    panel: string;
    form: string;
    check: string;
    input: string;
    muted: string;
    error: string;
    button: string;
    primary: string;
    danger: string;
    linkish: string;
    list: string;
    card: string;
    cardRevoked: string;
    cardHead: string;
    row: string;
    tag: string;
    tagDead: string;
    facts: string;
    holder: string;
    holderForm: string;
    token: string;
    copyRow: string;
    avatarField: string;
};
export type GrantsClassNames = Partial<typeof DEFAULT_CLASSES> & {
    avatar?: AvatarFieldProps['classNames'];
};
export interface GrantLinkProps {
    grant: Grant;
    /** The one-time token. Never kept anywhere but the controller's memory. */
    token: string;
    /** Link shape is the app's: e.g. `(g, t) => shareUrl(t, `${origin}/${g.scopes[0]}/`)`. */
    buildLink: (grant: Grant, token: string) => string;
    onDismiss?: () => void;
    labels?: Partial<Record<'warning' | 'copy' | 'copied' | 'copyFailed' | 'dismiss', ReactNode>>;
    classNames?: GrantsClassNames;
}
/** The moment a link exists outside its recipient's browser: show it, offer a copy, and say it won't come back. */
export declare function GrantLink({ grant, token, buildLink, onDismiss, labels, classNames }: GrantLinkProps): import("react").JSX.Element;
export interface GrantMintFormProps {
    /** Rendered as checkboxes; at least one must be chosen. A lone scope starts checked. */
    scopes: readonly GrantScope[];
    /** Resolve truthy once the link exists, which resets the form; falsy keeps what was typed. */
    onMint: (input: MintInput) => Promise<unknown>;
    busy?: boolean;
    error?: string | null;
    /** A starting memo, re-evaluated for each new link. */
    defaultMemo?: string | (() => string);
    /** Offered expiries, in days; 0 is "never". */
    expiryDays?: readonly number[];
    defaultExpiryDays?: number;
    /** Offered redemption caps; 0 is "unlimited". */
    maxRedeems?: readonly number[];
    /** Offer "also let this email sign in" (needs an `allowlist` store on the routes). */
    allowlist?: boolean;
    /** The `<basePath>/avatar` route, to offer choosing the holder's face. */
    avatarEndpoint?: string;
    labels?: Partial<Record<'memo' | 'holder' | 'email' | 'allowlist' | 'avatar' | 'scopes' | 'expires' | 'never' | 'maxRedeems' | 'unlimited' | 'submit' | 'submitting' | 'scopeRequired' | 'anon' | 'service', ReactNode>>;
    classNames?: GrantsClassNames;
}
export declare function GrantMintForm({ scopes, onMint, busy, error, defaultMemo, expiryDays, defaultExpiryDays, maxRedeems, allowlist, avatarEndpoint, labels, classNames, }: GrantMintFormProps): import("react").JSX.Element;
export interface GrantCardProps {
    grant: Grant;
    grants: UseGrantsResult;
    /** To label this link's scopes; an id no longer offered shows as itself. */
    scopes?: readonly GrantScope[];
    /**
     * A checkbox per scope, saved on each click, for adding or removing one on a
     * link already sent. Sessions already redeemed follow on their next request.
     * A scope no longer offered stays listed, so a save can't drop it unnoticed.
     */
    editScopes?: boolean;
    buildLink: (grant: Grant, token: string) => string;
    allowlist?: boolean;
    avatarEndpoint?: string;
    /** After the holder is edited: binding an email may have added an allowlist row. */
    onHolderSaved?: () => void;
    labels?: GrantLinkProps['labels'] & Partial<Record<'noMemo' | 'revoked' | 'expired' | 'disabled' | 'disabledNote' | 'enable' | 'disable' | 'rotate' | 'rotateConfirm' | 'revoke' | 'revokeConfirm' | 'lostToken' | 'someone' | 'edit' | 'save' | 'cancel' | 'holderName' | 'holderEmail' | 'allowlist' | 'face' | 'widelyOpened' | 'allowlistKeepsScopes' | 'anon' | 'service' | 'anonToggle' | 'serviceToggle', ReactNode>>;
    classNames?: GrantsClassNames;
}
/** One link: its status, scopes, holder, activity, and the verbs that change it. */
export declare function GrantCard({ grant, grants, scopes, editScopes, buildLink, allowlist, avatarEndpoint, onHolderSaved, labels, classNames }: GrantCardProps): import("react").JSX.Element;
export type GrantsPanelProps = ({
    client: AuthClient;
    controller?: undefined;
} | {
    controller: GrantsController;
    client?: undefined;
}) & Pick<GrantMintFormProps, 'scopes' | 'defaultMemo' | 'expiryDays' | 'defaultExpiryDays' | 'maxRedeems' | 'allowlist' | 'avatarEndpoint'> & {
    buildLink: (grant: Grant, token: string) => string;
    /** Re-read the list this often. Off by default. */
    pollMs?: number;
    /** A new link. Its token stays in the panel, not here. */
    onMinted?: (grant: Grant) => void;
    /** After a link is minted or its holder edited: anything derived from the allowlist should look again. */
    onChanged?: () => void;
    /** Before the form and before the list, e.g. what these links do in your app. */
    mintIntro?: ReactNode;
    listIntro?: ReactNode;
    mintHeading?: ReactNode;
    listHeading?: ReactNode;
    emptyLabel?: ReactNode;
    labels?: GrantMintFormProps['labels'];
    cardLabels?: GrantCardProps['labels'];
    /** Scope checkboxes on each link: see `GrantCard`. */
    editScopes?: boolean;
    classNames?: GrantsClassNames & {
        section?: string;
    };
};
/** A mint form over the list of links, composed from the exported parts. */
export declare function GrantsPanel({ client, controller, scopes, buildLink, pollMs, onMinted, onChanged, mintIntro, listIntro, mintHeading, listHeading, emptyLabel, labels, cardLabels, editScopes, classNames, defaultMemo, expiryDays, defaultExpiryDays, maxRedeems, allowlist, avatarEndpoint, }: GrantsPanelProps): import("react").JSX.Element;
export {};
