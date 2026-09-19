/**
 * R2 as an `AssetStore` — the fourth adapter, peer to `d1`/`cf-access`/`resend`,
 * and the only one for avatar bytes until a non-CF consumer appears.
 *
 * A profile row holds `asset://<id>`; the app serves the bytes from its own
 * origin (`GET /avatar/:id`, long-cache), which is the whole point — a private
 * page's face never comes from a third party. `del` runs when an avatar is
 * replaced, so the bucket doesn't accrete orphans.
 *
 * `R2Bucket` is a `@cloudflare/workers-types` global, like `D1Database`; nothing
 * is imported.
 */
import type { AssetStore } from '../core/assets.js';
export declare function r2AssetStore(bucket: R2Bucket): AssetStore;
