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
    /**
     * Also surface Google's One Tap prompt (the corner toast) on mount, not just
     * the button. Off by default: it's an overlay the visitor didn't ask for. Worth
     * it where nearly everyone signs in with Google (an internal dashboard).
     * `autoSelect` signs a returning visitor in with no click at all when exactly
     * one of their Google accounts has already granted *this* client.
     */
    prompt?: boolean | {
        autoSelect?: boolean;
    };
    /** Rendered when GSI can't load (SSR, offline, blocked, unsupported). The Ask 3 redirect button belongs here. */
    fallback?: ReactNode;
    /** Overridable for tests. Default the real GSI URL. */
    scriptSrc?: string;
}
/**
 * Google One Tap, **button-first**: a rendered "Sign in with Google" button. The
 * auto-surfacing prompt is opt-in (`prompt`), since it's an overlay the visitor
 * didn't ask for. It's the in-page, no-redirect variant of the redirect button,
 * and it degrades to `fallback` whenever GSI can't run — so a page always has a
 * working sign-in, and this is pure upgrade.
 *
 * Both the button and the prompt use FedCM where the browser has it (Chrome's own
 * account UI in the page, rather than a popup window). Google issues a credential
 * without showing its account chooser only once the account has granted *this*
 * client (a redirect sign-in doesn't count), and only with FedCM or third-party
 * cookies.
 *
 * The nonce is minted server-side (`googleOneTapNonce`) and echoed back with the
 * credential, so the POST is replay-bound without any client-trusted state.
 */
export declare function GoogleOneTap({ clientId, nonceEndpoint, verifyEndpoint, onSignedIn, onDenied, buttonOptions, className, prompt, fallback, scriptSrc, }: GoogleOneTapProps): import("react").JSX.Element;
