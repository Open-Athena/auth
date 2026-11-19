import type { ReactNode } from 'react';
import { type OaSignInAccount, type OaSignInVariant } from '../signin/index.js';
export type { OaSignInAccount, OaSignInVariant };
/** Whose button this is: OA's by default. Another org passes its own name and mark (and its colors in CSS). */
export interface OaSignInBrand {
    /** "Sign in with <name>". */
    name: string;
    /** About 22px square; color it with `currentColor` or the `--oa-signin-*` variables. */
    mark: ReactNode;
}
export interface OaSignInButtonProps {
    /** The sign-in start, e.g. `/auth/oa` (append `?next=` yourself). */
    href: string;
    variant?: OaSignInVariant;
    /** Default "Sign in with <brand name>". */
    label?: string;
    account?: OaSignInAccount | null;
    brand?: OaSignInBrand;
    className?: string;
}
/** The Open Athena mark (`OA_MARK`). */
export declare function OaMark({ size }: {
    size?: number;
}): import("react").JSX.Element;
export declare const OA_BRAND: OaSignInBrand;
/**
 * "Sign in with OA": a link to the app's broker sign-in (`/auth/oa`), styled to sit beside Google's button (40px tall,
 * mark at the start, label centered). Import `@open-athena/auth/react/ui.css` for its styles. `variant`: see
 * `OaSignInVariant` (`/signin`, which has the same button as an HTML string).
 */
export declare function OaSignInButton({ href, variant, label, account, brand, className }: OaSignInButtonProps): import("react").JSX.Element;
