/**
 * The social layer (specs/share-links-and-audit.md §5). No ACL fixes the
 * failure modes of sharing sensitive material by link, so these are the
 * normative controls: say that access is logged, and make the page attributable.
 */
import type { ReactNode } from 'react';
import { type Whoami } from './types.js';
export interface AccessNoticeProps {
    whoami: Whoami | null | undefined;
    /** Set false when `logViews` is off, so the copy stays true. */
    logged?: boolean;
    /** Optional honest extra: "you've viewed this 4 times". */
    viewCount?: number | null;
    className?: string;
    children?: ReactNode;
}
/**
 * *"Private link for Bob Smith · access is logged"* — the single
 * highest-leverage feature here. It sets accurate expectations, so nobody is
 * betrayed by discovering the log later, and it empirically dampens casual
 * forwarding harder than technical controls do, because the recipient now knows
 * the link is attributable to them.
 */
export declare function AccessNotice({ whoami, logged, viewCount, className, children }: AccessNoticeProps): import("react").JSX.Element | null;
export interface WatermarkProps {
    whoami: Whoami | null | undefined;
    /** Overrides the name derived from `whoami`. */
    text?: string;
    /** Repetitions across the layer. Default 60. */
    count?: number;
    className?: string;
}
/**
 * The data-room convention: render the recipient's name across the page so
 * screenshots stay attributable. Only the styles that make it *work* are inline
 * (it must not intercept clicks, and it must cover the viewport); colour,
 * opacity and rotation are left to `className`, since that's branding.
 */
export declare function Watermark({ whoami, text, count, className }: WatermarkProps): import("react").JSX.Element | null;
