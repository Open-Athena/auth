import type { BackchannelStore } from './store.js'
import { BodyTooLarge, boundedText, checkVerifierOptions, type LogoutVerifierOptions, verifyLogoutToken } from './verify.js'

export interface BackchannelReceiverOptions extends LogoutVerifierOptions {
  store: BackchannelStore
  /** Tombstone lifetime after receipt, including the adopter's callback/skew window. */
  retentionS: number
  /** Epoch seconds, not milliseconds. */
  now?: () => number
}

/** Opt-in endpoint handler only: it records revocation, but never clears or authorizes app sessions. */
export function backchannelLogoutReceiver(opts: BackchannelReceiverOptions): (req: Request) => Promise<Response> {
  checkVerifierOptions(opts)
  if (!Number.isSafeInteger(opts.retentionS) || opts.retentionS < (opts.maxLifetimeS ?? 120) + (opts.clockSkewS ?? 30)) {
    throw new RangeError('retention must cover token lifetime and clock skew')
  }
  const reply = (status: number) => new Response(status === 200 ? null : '{"error":"invalid_request"}\n', {
    status, headers: { 'cache-control': 'no-store', 'content-type': 'application/json', ...(status === 405 ? { allow: 'POST' } : {}) },
  })
  return async req => {
    if (req.method !== 'POST') return reply(405)
    if (req.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/x-www-form-urlencoded') return reply(400)
    let text: string
    try {
      text = await boundedText(req, 16384)
    } catch (e) {
      if (e instanceof BodyTooLarge) return reply(413)
      throw e
    }
    const form = new URLSearchParams(text)
    for (const name of new Set(form.keys())) if (form.getAll(name).length !== 1) return reply(400)
    const token = form.get('logout_token')
    if (!token) return reply(400)
    const nowS = opts.now?.() ?? Math.floor(Date.now() / 1000)
    const evidence = await verifyLogoutToken(token, opts, nowS)
    if (!evidence) return reply(400)
    const retainedUntil = nowS + opts.retentionS
    if (!Number.isSafeInteger(retainedUntil)) throw new RangeError('invalid retention deadline')
    const outcome = await opts.store.accept(evidence, nowS, retainedUntil)
    return reply(outcome === 'conflict' ? 400 : 200)
  }
}
