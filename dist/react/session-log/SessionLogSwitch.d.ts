import { type ReactNode } from 'react';
import { type SwitchState } from '../../core/session-log-shape.js';
/** The switch's one-line status. */
export declare function switchStatus(s: SwitchState): string;
/** The end an admin has picked: through a date, or no end date. */
export type SwitchEnd = 'dated' | 'indefinite';
export interface SessionLogSwitchViewProps {
    state: SwitchState;
    /** Today's UTC date: the earliest a new end may be. */
    today: string;
    /** The date field's value (`YYYY-MM-DD`). */
    date: string;
    onDate: (d: string) => void;
    end: SwitchEnd;
    onEnd: (e: SwitchEnd) => void;
    /** Turn on with the chosen end (also: change the end while on), or off. */
    onSet: (enabled: boolean) => void;
    busy: boolean;
    error: string | null;
    /** Shown under the heading (what's recorded, where to read it). */
    description?: ReactNode;
    className?: string;
}
/** The switch, as markup (pure: `SessionLogSwitch` wires it to the API). */
export declare function SessionLogSwitchView({ state, today, date, onDate, end, onEnd, onSet, busy, error, description, className, }: SessionLogSwitchViewProps): import("react").JSX.Element;
export interface SessionLogSwitchProps {
    /** The session-log routes' base path (default `/api/session-log`). */
    endpoint?: string;
    description?: ReactNode;
    className?: string;
}
/**
 * The admin switch: on through a UTC date (default 7 days, at most 31), on
 * with no end date (until an admin turns it off), or off. A dated run ends by
 * itself after its date.
 */
export declare function SessionLogSwitch({ endpoint, description, className }: SessionLogSwitchProps): import("react").JSX.Element | null;
