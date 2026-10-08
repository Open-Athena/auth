/** Where the current preview came from — mirrors the server's `AvatarRefKind`. */
export type AvatarFieldSource = 'github' | 'bluesky' | 'mastodon' | 'gravatar' | 'url' | 'site' | 'upload';
export interface AvatarFieldProps {
    /** `POST` preview endpoint (`authRoutes`' `<basePath>/avatar`). Default `/api/auth/avatar`. */
    endpoint?: string;
    /**
     * The face to store, as a `data:` URI the server re-validates and copies, or
     * null for none (initials). Controlled.
     */
    value: string | null;
    onChange: (value: string | null) => void;
    /** Whose face: with nothing typed, their Gravatar is previewed (see `autoGravatar`). */
    email?: string | null;
    /** Default true. False offers a "Use Gravatar" button instead of looking it up unprompted. */
    autoGravatar?: boolean;
    /** Initials for the preview when there's no image. */
    name?: string | null;
    /** Show the preview avatar beside the input. Default true. */
    preview?: boolean;
    /** Preview pixels. Default 48. */
    size?: number;
    /** Every face (uploaded or looked up) is center-cropped and downscaled to this many square pixels before it's sent. Default 256. */
    uploadSize?: number;
    id?: string;
    classNames?: Partial<Record<'field' | 'row' | 'input' | 'button' | 'preview' | 'hint', string>>;
    labels?: Partial<Record<'placeholder' | 'upload' | 'clear' | 'gravatar' | 'looking' | 'none' | AvatarFieldSource, string>>;
}
/**
 * One field for a person's face: paste a GitHub / Bluesky / Mastodon profile
 * (or handle), or an image address, or upload a file — or leave it empty and
 * get their Gravatar. Every option previews *before* anything is saved, via the
 * server, which fetches and sniffs the image; what comes back is a `data:` URI,
 * and that copy is what gets stored — never a link to the third party.
 *
 * LinkedIn, X and Facebook have no public way to fetch a profile photo, so a
 * pasted profile URL from them is refused with a pointer to "copy image
 * address" or an upload. Every face is downscaled in the browser before it's
 * stored (see `downscaleImage`), which also re-encodes away EXIF — so no
 * server-side image codec or resizing service is needed.
 */
export declare function AvatarField({ endpoint, value, onChange, email, autoGravatar, name, preview, size, uploadSize, id, classNames, labels, }: AvatarFieldProps): import("react").JSX.Element;
/**
 * Center-crop an image file to a square and downscale it to at most `size`
 * pixels, in the browser, returning a `data:` URI. No server-side image codec
 * (or Cloudflare Images) needed: re-encoding here keeps uploads small enough to
 * inline, and drops EXIF (GPS included) on the way.
 *
 * An SVG (a site's icon, usually a logo) is drawn whole, fitted into a `size`
 * square, rather than cropped: it has no pixels of its own to keep. Drawn
 * through an `<img>`, it runs no script and loads nothing, so what comes out is
 * plain pixels — an SVG itself is never stored.
 *
 * WebP where the browser can encode it (keeps transparency); Safari can't, so
 * there it falls back to JPEG over white.
 */
export declare function downscaleImage(file: Blob, { size, quality }?: {
    size?: number;
    quality?: number;
}): Promise<string>;
