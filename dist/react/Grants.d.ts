import { type ComponentType, type ReactNode } from 'react';
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
/** One page a link opens: the same key works on any path the app serves. */
export interface GrantLinkEntry {
    label: string;
    url: string;
    /** The scope this page belongs to: `GrantCard` shows it on that scope's row rather than in the list below. */
    scope?: string;
}
/** A link's URL, or one URL per page it opens (labeled), for a link with several scopes. */
export type GrantLinks = string | readonly GrantLinkEntry[];
/** Link shape is the app's: e.g. `(g, t) => shareUrl(t, `${origin}/${g.scopes[0]}/`)`, or one entry per scope. */
export type BuildGrantLink = (grant: Grant, token: string) => GrantLinks;
/**
 * Keeps password managers (1Password, LastPass, Bitwarden) from offering to fill a field: these are a recipient's
 * details, never the admin's own, and `autoComplete="off"` doesn't stop them.
 */
export declare const NO_AUTOFILL: {
    readonly autoComplete: "off";
    readonly 'data-1p-ignore': "true";
    readonly 'data-lpignore': "true";
    readonly 'data-bwignore': "true";
};
export interface GrantLinkProps {
    grant: Grant;
    /** The token: just minted or rotated, or a kept one fetched again. Held only in the controller's memory. */
    token: string;
    buildLink: BuildGrantLink;
    /** Scopes whose entries are shown elsewhere (`GrantCard` puts them on the scope rows); "Copy all" still includes them. */
    omitScopes?: readonly string[];
    /** The key is kept, so these links can be shown again: say so instead of "copy this now". */
    kept?: boolean;
    /** The gate's `keyParam` (the one new links use), for "Copy key". Default `key`. */
    keyParam?: string;
    onDismiss?: () => void;
    labels?: Partial<Record<'warning' | 'keptWarning' | 'copy' | 'copied' | 'copyAll' | 'copyKey' | 'copyFailed' | 'dismiss', ReactNode>>;
    classNames?: GrantsClassNames;
}
/**
 * The moment a link exists outside its recipient's browser: show it (or one row per page it opens), offer a copy
 * of each, of all of them, and of just the key, and say it won't come back.
 */
export declare function GrantLink({ grant, token, buildLink, omitScopes, kept, keyParam, onDismiss, labels, classNames }: GrantLinkProps): import("react").JSX.Element;
/** One copy control's job: what it copies, and how to copy it. */
export interface CopyProps {
    kind: 'scope' | 'entry' | 'key' | 'all';
    /** What this control does, for its tooltip and accessible name ("Copy link"). */
    label: string;
    /** What it copies, for display beside it where that isn't already shown ("All of them", "key", "all"). */
    name: string;
    /**
     * Resolves the text to copy. It fetches the kept key on first use, which is logged. Call it from the click handler,
     * so the clipboard write keeps the user gesture.
     */
    text: () => Promise<string>;
    /** Copy `text()` the library's way (`ClipboardItem` with a promise, falling back to `writeText`) and report how it went. */
    copy: () => Promise<'copied' | 'failed'>;
}
/**
 * Copy text that may not be known yet. Safari only lets a clipboard write follow a click if it starts in the click
 * handler, so the write gets a `ClipboardItem` whose content is still a promise; where that isn't supported, the text
 * is awaited and written with `writeText`.
 */
export declare function copyText(text: () => Promise<string>): Promise<'copied' | 'failed'>;
/**
 * The default copy control: a clipboard icon that turns into a check for a moment once copied, with a tooltip saying
 * what it copies, and a short error if the clipboard refused.
 */
export declare function CopyIcon({ label, copy }: CopyProps): import("react").JSX.Element;
export interface ScopeLinkProps {
    grant: Grant;
    scope: string;
    entry: GrantLinkEntry;
    Copy: ComponentType<CopyProps>;
    copyProps: CopyProps;
}
/** What sits after a scope's label while the card has a link for it: by default, just its copy control. */
export declare function DefaultScopeLink({ Copy, copyProps }: ScopeLinkProps): import("react").JSX.Element;
export interface ExtraLinksProps {
    grant: Grant;
    /** The entries not on a scope row. */
    entries: readonly GrantLinkEntry[];
    Copy: ComponentType<CopyProps>;
    /** Ready-made props for each control, in display order: entries, then key, then all. */
    copies: readonly CopyProps[];
    /** Set only while a just-minted key that isn't kept is on screen: hides the icons. */
    onDismiss?: () => void;
    /** The shown-once warning to put beside `onDismiss`'s "×". */
    warning?: ReactNode;
}
/** The line under the scopes: each other page, the key and "all", as name + icon pairs. */
export declare function DefaultExtraLinks({ Copy, copies, onDismiss, warning }: ExtraLinksProps): import("react").JSX.Element;
/** Swappable pieces of a card's links. Each falls back to the default; behavior (fetching, logging) stays the card's. */
export interface GrantLinkComponents {
    /** One copy control: a scope row's, a non-scope entry's, the key's, or "all"'s. */
    Copy?: ComponentType<CopyProps>;
    /** What sits after a scope's label: by default `<Copy>` when the card has a link for that scope. */
    ScopeLink?: ComponentType<ScopeLinkProps>;
    /** The line under the scopes: non-scope entries, the key and "all". */
    ExtraLinks?: ComponentType<ExtraLinksProps>;
}
/** How the app's `WhoamiChip` shows an `anon` link to its recipient; picks the anon checkbox's default wording. */
export type AnonChipMode = 'label' | 'pseudonym' | 'hidden';
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
    /** Match the app's `<WhoamiChip anon=…>`, so the anon checkbox says what the recipient will see. Default `label`. */
    anonChip?: AnonChipMode;
    /**
     * Keep each new link's key, sealed, so staff can copy it again later (`Grant.kept`); a checkbox offers the other
     * choice. Default false: a key is shown once.
     */
    keepTokens?: boolean;
    labels?: Partial<Record<'keepKey' | 'forgetKey' | 'memo' | 'holder' | 'email' | 'allowlist' | 'avatar' | 'scopes' | 'expires' | 'never' | 'maxRedeems' | 'unlimited' | 'submit' | 'submitting' | 'scopeRequired' | 'anon' | 'service', ReactNode>>;
    classNames?: GrantsClassNames;
}
export declare function GrantMintForm({ scopes, onMint, busy, error, defaultMemo, expiryDays, defaultExpiryDays, maxRedeems, allowlist, avatarEndpoint, anonChip, keepTokens, labels, classNames, }: GrantMintFormProps): import("react").JSX.Element;
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
    buildLink: BuildGrantLink;
    allowlist?: boolean;
    avatarEndpoint?: string;
    /** After the holder is edited: binding an email may have added an allowlist row. */
    onHolderSaved?: () => void;
    /** See `GrantMintFormProps.anonChip`. */
    anonChip?: AnonChipMode;
    /** See `GrantLinkProps.keyParam`. */
    keyParam?: string;
    /** Replacements for the copy controls and where they sit (`GrantLinkComponents`); each defaults to the built-in. */
    components?: GrantLinkComponents;
    labels?: GrantLinkProps['labels'] & Partial<Record<'noMemo' | 'revoked' | 'expired' | 'disabled' | 'disabledNote' | 'enable' | 'disable' | 'rotate' | 'rotateConfirm' | 'revoke' | 'revokeConfirm' | 'lostToken' | 'someone' | 'edit' | 'save' | 'cancel' | 'holderName' | 'holderEmail' | 'allowlist' | 'face' | 'widelyOpened' | 'allowlistKeepsScopes' | 'anon' | 'service' | 'anonToggle' | 'serviceToggle' | 'copyLink' | 'keyName' | 'allName' | 'keptNote' | 'forgetKept' | 'forgetKeptConfirm' | 'keepExisting' | 'keepExistingHint' | 'keepExistingSave', ReactNode>>;
    classNames?: GrantsClassNames;
}
/** One link: its status, scopes, holder, activity, and the verbs that change it. */
export declare function GrantCard({ grant, grants, scopes, editScopes, buildLink, allowlist, avatarEndpoint, onHolderSaved, anonChip, keyParam, components, labels, classNames }: GrantCardProps): import("react").JSX.Element;
export type GrantsPanelProps = ({
    client: AuthClient;
    controller?: undefined;
} | {
    controller: GrantsController;
    client?: undefined;
}) & Pick<GrantMintFormProps, 'scopes' | 'defaultMemo' | 'expiryDays' | 'defaultExpiryDays' | 'maxRedeems' | 'allowlist' | 'avatarEndpoint' | 'anonChip' | 'keepTokens'> & {
    buildLink: BuildGrantLink;
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
    /** See `GrantLinkProps.keyParam`. */
    keyParam?: string;
    /** Passed to each card: see `GrantCardProps.components`. */
    components?: GrantLinkComponents;
    classNames?: GrantsClassNames & {
        section?: string;
    };
};
/** A mint form over the list of links, composed from the exported parts. */
export declare function GrantsPanel({ client, controller, scopes, buildLink, pollMs, onMinted, onChanged, mintIntro, listIntro, mintHeading, listHeading, emptyLabel, labels, cardLabels, editScopes, keyParam, components, classNames, defaultMemo, expiryDays, defaultExpiryDays, maxRedeems, allowlist, avatarEndpoint, anonChip, keepTokens, }: GrantsPanelProps): import("react").JSX.Element;
export {};
