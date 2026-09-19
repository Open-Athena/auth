import { type ReactNode } from 'react';
export interface GoogleOneTapProps {
    /** The public OAuth client id. Safe in the page by design. */
    clientId: string;
    /** `GET` → `{ nonce }`. Default `/api/auth/google/onetap/nonce`. */
    nonceEndpoint?: string;
    /** `POST {credential, nonce}`. Default `/api/auth/google/onetap`. */
    verifyEndpoint?: string;
    /** Called after a credential verifies — refetch `useWhoami`. */
    onSignedIn?: () => void;
    /** Verified but not on the allowlist: the Google-verified email, for request-access pre-fill. */
    onDenied?: (email: string) => void;
    /** Options forwarded to `renderButton` (theme, size, text, shape, width). */
    buttonOptions?: Record<string, unknown>;
    className?: string;
    /** Rendered when GSI can't load (SSR, offline, blocked, unsupported). The Ask 3 redirect button belongs here. */
    fallback?: ReactNode;
    /** Overridable for tests. Default the real GSI URL. */
    scriptSrc?: string;
}
/**
 * Google One Tap, **button-first**: a rendered "Sign in with Google" button, not
 * the auto-surfacing prompt (no overlay a visitor didn't ask for, no display
 * caps). It's the in-page, no-redirect variant of the Ask 3 button, and it
 * degrades to `fallback` whenever GSI can't run — so a page always has a working
 * sign-in, and this is pure upgrade.
 *
 * The nonce is minted server-side (`googleOneTapNonce`) and echoed back with the
 * credential, so the POST is replay-bound without any client-trusted state.
 */
export declare function GoogleOneTap({ clientId, nonceEndpoint, verifyEndpoint, onSignedIn, onDenied, buttonOptions, className, fallback, scriptSrc, }: GoogleOneTapProps): import("react").JSX.Element;
