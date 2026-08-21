/**
 * Resend as a `SendEmail`.
 *
 * A dozen lines, which is the point of the interface being small: swapping to
 * Postmark or SES is a sibling file, not a refactor. Chosen over the
 * alternatives because it needs no SDK — one `fetch` to one endpoint — which
 * matters in a Worker.
 *
 * Note MailChannels' free Workers integration ended in 2024, so an ESP is a
 * real dependency now rather than a footnote.
 */
import type { EmailMessage, SendEmail, SendResult } from '../core/email.js'

export interface ResendOptions {
  /** `re_...`. Scope it to the one domain you send from if the provider allows. */
  apiKey: string
  /** Default `from`, overridable per message. */
  from?: string
  fetch?: typeof globalThis.fetch
}

const ENDPOINT = 'https://api.resend.com/emails'

export function resendEmail({ apiKey, from: defaultFrom, fetch = globalThis.fetch }: ResendOptions): SendEmail {
  return async (msg: EmailMessage): Promise<SendResult> => {
    const from = msg.from ?? defaultFrom
    if (!from) return { ok: false, error: 'no `from` address configured' }

    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        from,
        to: Array.isArray(msg.to) ? msg.to : [msg.to],
        subject: msg.subject,
        text: msg.text,
        ...(msg.html ? { html: msg.html } : {}),
        ...(msg.replyTo ? { reply_to: msg.replyTo } : {}),
      }),
    }).catch((e: unknown) => ({ ok: false, status: 0, text: async () => String(e) }) as unknown as Response)

    if (!res.ok) {
      // The body carries Resend's own message ("domain is not verified" is the
      // one everybody hits first), and it must reach the caller — a magic-link
      // flow that silently sends nothing is the worst failure mode here.
      const detail = await res.text().catch(() => '')
      return { ok: false, error: `resend ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}` }
    }
    const body = (await res.json().catch(() => ({}))) as { id?: string }
    return { ok: true, ...(body.id ? { id: body.id } : {}) }
  }
}
