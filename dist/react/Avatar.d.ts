import { type Whoami } from './types.js';
export interface AvatarProps {
    whoami?: Whoami | null;
    /**
     * A name to draw initials from, for the places that have a person but no
     * identity — an admin's request queue, most of all.
     */
    name?: string | null;
    /**
     * An explicit image. Defaults to `subject.avatar` when the identity carries
     * one; falls back to initials if it fails to load.
     *
     * No Gravatar by default, on purpose: fetching one tells a third party the
     * hash of your visitor's address on every render of a page whose whole
     * premise is that access is private. An app that judges that trade worthwhile
     * passes the URL in here itself.
     */
    src?: string | null;
    /** Pixels. Also the font size basis for the initials fallback. */
    size?: number;
    className?: string;
    /** Override the initials (default: from `displayName`). */
    initials?: string;
}
/**
 * Up to two initials, code-point-safe so a name starting with an emoji or an
 * astral-plane character doesn't render half a surrogate pair.
 */
export declare function initialsOf(name: string | null | undefined): string;
/** A face for the chip and the request table: an image if there is one, else initials. */
export declare function Avatar({ whoami, name: nameProp, src, size, className, initials }: AvatarProps): import("react").JSX.Element | null;
