import { type ReactNode } from 'react';
import type { SessionRow } from '../../core/session-log-shape.js';
/** How the viewer renders a link: a plain `<a>` by default; pass your router's `Link` for in-app navigation. */
export type RenderLink = (p: {
    href: string;
    className?: string;
    children: ReactNode;
}) => ReactNode;
/** Who a session was, by default: the address, else "anonymous", and a share-link session is tagged as such. */
export declare function DefaultViewer({ s }: {
    s: Pick<SessionRow, 'email' | 'via'>;
}): import("react").JSX.Element;
/** The list's filters and page, as its URL would hold them (`u`, `since`, `err`, `after` / `before`). */
export interface SessionListParams {
    email: string;
    since: string;
    errors: boolean;
    after: string | null;
    before: string | null;
}
export declare const EMPTY_PARAMS: SessionListParams;
export interface SessionListProps {
    /** The session-log routes' base path (default `/api/session-log`). */
    endpoint?: string;
    /** Controlled filters and page (keep them in your URL); uncontrolled when absent. */
    params?: SessionListParams;
    onParams?: (next: SessionListParams, opts: {
        replace: boolean;
    }) => void;
    /** A session's timeline page. */
    sessionHref: (sid: string) => string;
    renderLink?: RenderLink;
    /** Who a row was (e.g. your app's user chip); `DefaultViewer` otherwise. */
    renderViewer?: (s: SessionRow) => ReactNode;
    className?: string;
}
/** Sessions, most recently active first, 50 a page, filterable by address, start date and errors. */
export declare function SessionList({ endpoint, params: controlled, onParams, sessionHref, renderLink, renderViewer, className, }: SessionListProps): import("react").JSX.Element;
export interface SessionViewProps {
    sid: string;
    endpoint?: string;
    renderViewer?: (s: SessionRow) => ReactNode;
    className?: string;
}
/** One session: a strip of its events over time, then the timeline table, each row with "open this view". */
export declare function SessionView({ sid, endpoint, renderViewer, className, }: SessionViewProps): import("react").JSX.Element;
