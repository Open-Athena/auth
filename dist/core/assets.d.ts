/**
 * Where an avatar's *bytes* live when they are too big to inline as a `data:`
 * URI on the profile row. Runtime-agnostic, like the store interfaces: the
 * default binding is **none** (profiles inline ≤ 64 KB with zero new infra), and
 * an app that wants larger faces binds an adapter — `adapters/r2.ts` is the CF
 * one. A profile row then holds `asset://<id>` and the app serves it from its
 * own origin (`GET /avatar/:id`), which is the whole point: the image never
 * comes from a third party.
 */
export interface StoredAsset {
    bytes: Uint8Array;
    /** The content type to serve it with — an `image/*` validated on the way in. */
    type: string;
}
export interface AssetStore {
    /** Store bytes, returning an opaque id to reference them by. */
    put(bytes: Uint8Array, type: string): Promise<string>;
    get(id: string): Promise<StoredAsset | null>;
    del(id: string): Promise<void>;
}
/** Prefix marking a profile `avatar` value that resolves through an `AssetStore`. */
export declare const ASSET_URI_PREFIX = "asset://";
export declare const assetUri: (id: string) => string;
/** The id inside an `asset://<id>` value, or null if it isn't one. */
export declare function assetId(avatar: string | null | undefined): string | null;
