import type { ReactNode } from 'react';
import { type Whoami } from './types.js';
export interface WhoamiChipProps {
    whoami: Whoami | null | undefined;
    /** Default `/api/auth/logout`. Pass null for Tier 1, where the edge owns the session. */
    logoutEndpoint?: string | null;
    signOutLabel?: ReactNode;
    onSignedOut?: () => void;
    classNames?: Partial<Record<'root' | 'name' | 'button', string>>;
}
/** Header chip: who you are, and how to stop being them. */
export declare function WhoamiChip({ whoami, logoutEndpoint, signOutLabel, onSignedOut, classNames, }: WhoamiChipProps): import("react").JSX.Element | null;
