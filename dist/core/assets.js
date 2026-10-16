/**
 * Where an avatar's *bytes* live when they are too big to inline as a `data:`
 * URI on the profile row. Runtime-agnostic, like the store interfaces: the
 * default binding is **none** (profiles inline ≤ 64 KB with zero new infra), and
 * an app that wants larger faces binds an adapter — `adapters/r2.ts` is the CF
 * one. A profile row then holds `asset://<id>` and the app serves it from its
 * own origin (`GET /avatar/:id`), which is the whole point: the image never
 * comes from a third party.
 */
/** Prefix marking a profile `avatar` value that resolves through an `AssetStore`. */
export const ASSET_URI_PREFIX = 'asset://';
export const assetUri = (id) => `${ASSET_URI_PREFIX}${id}`;
/** The id inside an `asset://<id>` value, or null if it isn't one. */
export function assetId(avatar) {
    return avatar?.startsWith(ASSET_URI_PREFIX) ? avatar.slice(ASSET_URI_PREFIX.length) : null;
}
