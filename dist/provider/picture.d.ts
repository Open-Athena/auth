/**
 * The `picture` claim for a face stored as a `data:` URI or an `asset://` ref:
 * a URL under the provider, good for as long as the token carrying it, that an
 * app fetches once and copies (`seedProfileFromClaims`).
 *
 * Why not the alternatives:
 * - the image itself would put up to 64 KB in every token;
 * - the IdP's URL (`lh3.googleusercontent.com`) is deliberately never stored;
 * - a permanent URL would be a public address for someone's face, sitting in
 *   whatever an app logs, and revoking one would need a table and a way to use it.
 *
 * The path segment is an encrypted ticket (AES-GCM) rather than a signed one, so
 * the URL doesn't show the email in a log. It's a bearer capability: anyone
 * holding the URL can fetch until it expires, with no cookie or client secret,
 * because the fetch is `copyAvatar`'s plain GET. What's served is read when the
 * request arrives, so a photo removed since the token was issued is gone.
 */
import { type StoredAsset } from '../core/assets.js';
export interface PictureTicket {
    email: string;
    clientId: string;
    /** Epoch seconds. */
    expiresAt: number;
}
export declare function pictureTickets(secret: string): {
    seal({ email, clientId, expiresAt }: PictureTicket): Promise<string>;
    /** The ticket, or null if it's not one of ours. Expiry is the caller's to check. */
    open(ticket: string): Promise<PictureTicket | null>;
};
/** A stored face this route can serve: the kinds with no URL of their own. */
export declare const isHostedAvatar: (avatar: string) => boolean;
/**
 * The stored face as an image response, or null if there's no such image or the
 * bytes aren't a raster image. The type is sniffed from the bytes, never taken
 * from the `data:` label or the asset's record.
 */
export declare function pictureResponse(avatar: string, getAsset: (id: string) => Promise<StoredAsset | null>): Promise<Response | null>;
