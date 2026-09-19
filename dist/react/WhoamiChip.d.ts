import type { ReactNode } from 'react';
import { type Whoami } from './types.js';
export interface WhoamiChipProps {
    whoami: Whoami | null | undefined;
    /** Default `/api/auth/logout`. Pass null for Tier 1, where the edge owns the session. */
    logoutEndpoint?: string | null;
    signOutLabel?: ReactNode;
    /**
     * Shown when the identity has no name — an anonymous share link. Without it
     * the chip would render nothing, taking the sign-out control with it, which
     * is the one case where a visitor most needs a way out.
     */
    anonymousLabel?: ReactNode;
    onSignedOut?: () => void;
    /** Show an `<Avatar>` before the name. Off by default: it changes the layout. */
    avatar?: boolean | {
        src?: string | null;
        size?: number;
    };
    /**
     * Make the avatar + name a click target — "click your face to edit it". When
     * set, they render as a `<button>` calling this, so an app can open a
     * `<ProfilePanel>` without wiring its own hit area.
     */
    onOpenProfile?: () => void;
    classNames?: Partial<Record<'root' | 'name' | 'button' | 'avatar' | 'identity', string>>;
}
/** Header chip: who you are, and how to stop being them. */
export declare function WhoamiChip({ whoami, logoutEndpoint, signOutLabel, anonymousLabel, onSignedOut, avatar, onOpenProfile, classNames, }: WhoamiChipProps): import("react").JSX.Element | null;
