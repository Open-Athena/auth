import { generateId } from '../core/tokens.js';
export function r2AssetStore(bucket) {
    return {
        async put(bytes, type) {
            const id = generateId();
            await bucket.put(id, bytes, { httpMetadata: { contentType: type } });
            return id;
        },
        async get(id) {
            const obj = await bucket.get(id);
            if (!obj)
                return null;
            const bytes = new Uint8Array(await obj.arrayBuffer());
            // Prefer the stored content type; fall back to a generic image type
            // rather than letting a served avatar go untyped.
            const type = obj.httpMetadata?.contentType ?? 'application/octet-stream';
            return { bytes, type };
        },
        async del(id) {
            await bucket.delete(id);
        },
    };
}
