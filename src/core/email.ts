/**
 * Outbound email: the missing half of magic links.
 *
 * `requestAccess` + `anyEmailPolicy` has always been passwordless sign-up — an
 * address is auto-approved, a grant bound to it is minted, and the grant is
 * handed to `notify`. What made it a half-feature is that *delivery is the
 * verification*: a link sent to the claimed address proves mailbox control,
 * and a link handed straight back to whoever typed the address proves nothing
 * at all. Everything here exists to close that gap.
 *
 * `SendEmail` is deliberately tiny. Providers differ in everything except
 * "here is a message, send it", so that is the whole interface, and an adapter
 * (see `adapters/resend.ts`) is a dozen lines.
 */
import type { Notify, NotifyEvent } from './requests.js'

export interface EmailMessage {
  to: string | string[]
  subject: string
  /**
   * Required, even when `html` is set. A message with no text part scores
   * worse with spam filters, and a magic link that lands in spam is
   * indistinguishable from a broken gate.
   */
  text: string
  html?: string
  from?: string
  replyTo?: string
}

export type SendEmail = (msg: EmailMessage) => Promise<SendResult>

export type SendResult = { ok: true; id?: string } | { ok: false; error: string }

export interface EmailNotifyOptions {
  send: SendEmail
  /** `Name <addr@domain>`; the domain must be one the provider has verified. */
  from: string
  /** Where `access-requested` goes. Without it, admin notifications are skipped. */
  adminTo?: string | string[]
  /** Shown in subjects and body copy. */
  appName?: string
  /**
   * Builds the URL a recipient clicks. Owning this matters: apps differ on
   * `?key=` vs a path, and on which page a redeemed link should land on.
   */
  linkFor: (token: string) => string
  /** Where an admin reviews the queue, linked from the notification. */
  adminUrl?: string
  /**
   * Gates *recipient* delivery, and nothing else.
   *
   * A deployment often can't or shouldn't mail every address someone types —
   * a staging instance that only mails staff, a public demo that would
   * otherwise be an unsolicited-mail cannon aimed at third parties. Returning
   * false suppresses the `access-granted` mail to that address.
   *
   * Admin notifications are deliberately *not* subject to this. Mailing a
   * stranger is the risk; mailing yourself never is, and the requests most
   * worth hearing about are exactly the ones from outside your own domains.
   * Gating both on one predicate silently drops those.
   *
   * Default: everyone.
   */
  deliverTo?: (email: string) => boolean
  /**
   * Called instead of sending, when `deliverTo` returns false. The token is on
   * the event; an app that wants to show the link on screen rather than mail it
   * takes it from here.
   */
  onUndelivered?: (event: Extract<NotifyEvent, { kind: 'access-granted' }>) => void
  /**
   * Called when a send fails. Default: swallow. A failed notification must not
   * fail the request that triggered it — the grant is already minted, and
   * throwing here would turn "the mail didn't go out" into "sign-up is broken".
   */
  onError?: (error: string, event: NotifyEvent) => void
}

/**
 * A `Notify` that sends mail. Wire it into `createGate({ notify })`.
 *
 * The `access-granted` message is the only place a token is ever rendered, and
 * it goes to the address the grant is bound to and nowhere else — not to the
 * admin who approved it, and not into a log line.
 */
export function emailNotify(opts: EmailNotifyOptions): Notify {
  const {
    send,
    from,
    adminTo,
    appName = 'this site',
    linkFor,
    adminUrl,
    deliverTo = () => true,
    onUndelivered = () => {},
    onError = () => {},
  } = opts

  return async (event: NotifyEvent): Promise<void> => {
    if (event.kind === 'access-granted' && !deliverTo(event.request.email)) {
      onUndelivered(event)
      return
    }
    const msg = compose(event)
    if (!msg) return
    const res = await send({ from, ...msg }).catch(e => ({ ok: false as const, error: String(e) }))
    if (!res.ok) onError(res.error, event)
  }

  function compose(event: NotifyEvent): Omit<EmailMessage, 'from'> | null {
    switch (event.kind) {
      case 'access-granted': {
        const url = linkFor(event.token)
        return {
          to: event.request.email,
          // No token in the subject: subjects are logged, previewed on lock
          // screens, and quoted in replies.
          subject: `Your link to ${appName}`,
          text: [
            greeting(event.request.name),
            ``,
            `Here's your link to ${appName}:`,
            ``,
            url,
            ``,
            `It's tied to this email address, so there's no password to set.`,
            `If you didn't ask for this, you can ignore it — the link is only useful to whoever opens it.`,
          ].join('\n'),
        }
      }

      case 'access-requested': {
        if (!adminTo) return null
        const { email, name, note } = event.request
        return {
          to: adminTo,
          subject: `Access request from ${email}`,
          // Replying reaches the person who asked, which is usually what an
          // admin wants to do first.
          replyTo: email,
          text: [
            `${name ? `${name} <${email}>` : email} asked for access to ${appName}.`,
            ...(note ? [``, `They said: ${note}`] : []),
            ...(adminUrl ? [``, `Approve or deny: ${adminUrl}`] : []),
          ].join('\n'),
        }
      }

      case 'access-denied':
        // Deliberately silent. A denial notice tells someone who may have been
        // probing that the address exists and that a human looked at it, and
        // there is nothing actionable in it for a legitimate requester.
        return null
    }
  }
}

const greeting = (name: string | null): string => (name ? `Hi ${name.split(' ')[0]},` : 'Hi,')
