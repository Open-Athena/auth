import { type FormEvent, type ReactNode, useState } from 'react'

export type EmailCodeState = 'email' | 'sending' | 'code' | 'verifying' | 'error'

export interface EmailCodeFormProps {
  /** Where `POST {email}` starts the flow. Default `/api/auth/email/start`. */
  startEndpoint?: string
  /** Where `POST {id, code}` mints the session. Default `/api/auth/email/code`. */
  verifyEndpoint?: string
  /** Called after the code verifies — refetch `useWhoami` so the wall drops. */
  onSignedIn?: () => void
  /** Pre-fill the address (e.g. a Google-verified one after a denied redirect). */
  defaultEmail?: string
  classNames?: Partial<Record<'form' | 'field' | 'label' | 'input' | 'button' | 'message' | 'back', string>>
  labels?: Partial<Record<'email' | 'code' | 'send' | 'sending' | 'verify' | 'verifying' | 'back', ReactNode>>
  /** Copy shown once a code has been sent. `email` is interpolated by the caller if desired. */
  sentHint?: (email: string) => ReactNode
}

/**
 * The wall's third affordance: sign in with a code emailed to you, for the tail
 * of users who can't (or won't) use Google. Two steps — enter an address, then
 * enter the 6-digit code that arrives — because typing the code back into *this*
 * tab is what rescues the cross-device case (the mail is on your phone). The
 * matching magic link in the same email is the one-click path when it's the
 * same device.
 *
 * The server answers `start` identically whether or not the address is allowed,
 * so this form can't be used to probe the allowlist; a genuinely-not-allowed
 * person simply never receives a code and uses request-access instead.
 */
export function EmailCodeForm({
  startEndpoint = '/api/auth/email/start',
  verifyEndpoint = '/api/auth/email/code',
  onSignedIn,
  defaultEmail = '',
  classNames = {},
  labels = {},
  sentHint = email => `Enter the code we emailed to ${email}, or open the link in that email.`,
}: EmailCodeFormProps) {
  const [state, setState] = useState<EmailCodeState>('email')
  const [email, setEmail] = useState(defaultEmail)
  const [id, setId] = useState('')

  async function start(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (state === 'sending') return
    const addr = String(new FormData(e.currentTarget).get('email') ?? '').trim()
    setEmail(addr)
    setState('sending')
    try {
      const res = await fetch(startEndpoint, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: addr }),
      })
      const parsed = (await res.json().catch(() => ({}))) as { status?: string; id?: string }
      // The response is constant for allowed and not-allowed addresses; either
      // way we advance to code entry (a not-allowed address just never gets one).
      if (res.ok && parsed.status === 'sent' && parsed.id) {
        setId(parsed.id)
        setState('code')
      } else {
        setState('error')
      }
    } catch {
      setState('error')
    }
  }

  async function verify(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (state === 'verifying') return
    const code = String(new FormData(e.currentTarget).get('code') ?? '').trim()
    setState('verifying')
    try {
      const res = await fetch(verifyEndpoint, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id, code }),
      })
      const parsed = (await res.json().catch(() => ({}))) as { ok?: boolean }
      if (res.ok && parsed.ok) {
        onSignedIn?.()
      } else {
        // Wrong or expired code: stay on the step so it can be retyped.
        setState('code')
      }
    } catch {
      setState('code')
    }
  }

  if (state === 'code' || state === 'verifying') {
    return (
      <form className={classNames.form} onSubmit={verify}>
        <p className={classNames.message}>{sentHint(email)}</p>
        <div className={classNames.field}>
          <label className={classNames.label} htmlFor="oa-auth-code">
            {labels.code ?? 'Code'}
          </label>
          <input
            className={classNames.input}
            id="oa-auth-code"
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]*"
            required
          />
        </div>
        <button className={classNames.button} type="submit" disabled={state === 'verifying'}>
          {state === 'verifying' ? (labels.verifying ?? 'Signing in…') : (labels.verify ?? 'Sign in')}
        </button>
        <button
          className={classNames.back}
          type="button"
          onClick={() => setState('email')}
          disabled={state === 'verifying'}
        >
          {labels.back ?? 'Use a different email'}
        </button>
      </form>
    )
  }

  return (
    <form className={classNames.form} onSubmit={start}>
      <div className={classNames.field}>
        <label className={classNames.label} htmlFor="oa-auth-code-email">
          {labels.email ?? 'Email'}
        </label>
        <input
          className={classNames.input}
          id="oa-auth-code-email"
          name="email"
          type="email"
          required
          autoComplete="email"
          defaultValue={defaultEmail}
        />
      </div>
      <button className={classNames.button} type="submit" disabled={state === 'sending'}>
        {state === 'sending' ? (labels.sending ?? 'Sending…') : (labels.send ?? 'Email me a code')}
      </button>
      {state === 'error' && <p className={classNames.message}>Something went wrong. Try again?</p>}
    </form>
  )
}
