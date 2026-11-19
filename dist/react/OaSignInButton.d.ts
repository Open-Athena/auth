import type { ReactNode } from 'react';
/**
 * How the button looks (ui.css, `.oa-signin-<variant>`), from the Open Athena brand guidelines' palette:
 * - `taupe` (default): taupe `#A99B8D`, the mark and label in OA black.
 * - `neutral`: Google's own recipe, a plain button (white, or near-black under a dark color scheme) with the mark in its
 *   colors.
 * - `blue`: OA blue `#224A82`, the mark on a white tile, the way Google's blue button carries its logo.
 * Each is a set of `--oa-signin-*` variables, so a host can restyle any of them.
 */
export type OaSignInVariant = 'taupe' | 'neutral' | 'blue';
/** Whose button this is: OA's by default. Another org passes its own name and mark (and its colors in CSS). */
export interface OaSignInBrand {
    /** "Sign in with <name>". */
    name: string;
    /** About 22px square; color it with `currentColor` or the `--oa-signin-*` variables. */
    mark: ReactNode;
}
/** A returning visitor, shown Google's way: their face, "Continue as <first name>" over their address, the mark last. */
export interface OaSignInAccount {
    email: string;
    name?: string | null;
    avatar?: string | null;
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
/** The Open Athena mark (the logo's stems and rings, from "Open Athena Logo Color.svg"). */
export declare function OaMark({ size }: {
    size?: number;
}): import("react").JSX.Element;
export declare const OA_BRAND: OaSignInBrand;
/**
 * "Sign in with OA": a link to the app's broker sign-in (`/auth/oa`), styled to sit beside Google's button (40px tall,
 * mark at the start, label centered). Import `@open-athena/auth/react/ui.css` for its styles.
 */
export declare function OaSignInButton({ href, variant, label, account, brand, className }: OaSignInButtonProps): import("react").JSX.Element;
