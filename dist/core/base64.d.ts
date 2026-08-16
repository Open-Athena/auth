/** base64url codecs (no padding). Loop-based, so large inputs can't blow the stack. */
export declare function b64uEncode(buf: ArrayBuffer | Uint8Array): string;
export declare function b64uDecodeBytes(s: string): Uint8Array;
export declare function b64uDecodeString(s: string): string;
