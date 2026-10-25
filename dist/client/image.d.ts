/**
 * `downscaleImage` for a `data:` URI. Where the browser can't decode or
 * re-encode (no `createImageBitmap`, as in jsdom), the original passes through
 * and the server's storage cap is the backstop.
 */
export declare function downscaleDataUri(uri: string, size: number): Promise<string>;
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
