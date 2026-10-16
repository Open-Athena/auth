import { type ReactNode } from 'react';
import { type EmailCodeFormProps } from './EmailCodeForm.js';
import { type GoogleOneTapProps } from './GoogleOneTap.js';
import { type RequestAccessFormProps } from './RequestAccessForm.js';
export interface SignInPanelProps {
    /**
     * The primary affordance: "Continue with Google" → an immediate redirect to
     * the OIDC start Function (e.g. `/auth/google`). Google's picker handles
     * identity; the app checks its allowlist when the id_token comes back.
     */
    googleUrl?: string;
    googleLabel?: ReactNode;
    /**
     * Google's own in-page button (`GoogleOneTap`), in the same slot: while it
     * renders, the `googleUrl` redirect button is its fallback rather than a second
     * "Continue with Google" beside it. `onSignedIn` is the panel's.
     */
    oneTap?: Omit<GoogleOneTapProps, 'fallback' | 'onSignedIn'>;
    /**
     * Once the server reports a remembered account (`googleOneTapNonce`'s
     * `loginHint`), the Google slot becomes the redirect, labelled with it: the
     * start URL hints that account to Google, which then skips its chooser, so a
     * returning visitor is one click from signed in. Google's own button stays
     * mounted (hidden), for its prompt. `false` keeps Google's button.
     */
    continueAs?: false | ((email: string) => ReactNode);
    /**
     * Under that button: a link back through Google's chooser
     * (`?account=choose`). Given the address; `false` hides it.
     */
    switchAccount?: false | ((email: string) => ReactNode);
    /** Append the current path so a redirect returns the visitor where they started. Default true. */
    withNext?: boolean;
    /**
     * The secondary affordance: sign in with an emailed code, for addresses that
     * can't use Google. `true` for defaults, or pass `EmailCodeForm` props.
     */
    emailAuth?: boolean | EmailCodeFormProps;
    /** Refetch `useWhoami` after an in-page sign-in (email code / One Tap). */
    onSignedIn?: () => void;
    title?: ReactNode;
    hint?: ReactNode;
    /** Render the request-access form. `true` for defaults, or pass props. */
    requestAccess?: boolean | RequestAccessFormProps;
    children?: ReactNode;
    classNames?: Partial<Record<'root' | 'title' | 'hint' | 'button' | 'googleButton' | 'switchAccount' | 'divider', string>>;
}
/**
 * The address a denied sign-in redirected back with (`/?denied=<email>`). Google
 * (or an email link) verified it, so pre-filling request-access with it means an
 * admin approves an address that was *proven*, not merely typed.
 */
export declare function deniedEmail(): string | undefined;
/**
 * The wall. Google-first (one button, no typing), with two fallbacks — an
 * emailed code for the non-Google tail, and request-access for everyone the
 * allowlist doesn't yet know. A revoked or expired link should land *here*, not
 * on a bare 403: the person who legitimately lost access self-serves, and the
 * person who shouldn't have it hits a door that names itself.
 */
export declare function SignInPanel({ googleUrl, googleLabel, oneTap, continueAs, switchAccount, withNext, emailAuth, onSignedIn, title, hint, requestAccess, children, classNames, }: SignInPanelProps): import("react").JSX.Element;
