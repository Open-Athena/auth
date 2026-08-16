/** base64url codecs (no padding). Loop-based, so large inputs can't blow the stack. */

export function b64uEncode(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

export function b64uDecodeBytes(s: string): Uint8Array {
  const bin = atob(s.replaceAll('-', '+').replaceAll('_', '/'))
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

export function b64uDecodeString(s: string): string {
  return new TextDecoder().decode(b64uDecodeBytes(s))
}
