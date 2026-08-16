import { type FormEvent, useState } from 'react'

export type RequestState = 'idle' | 'submitting' | 'pending' | 'invalid' | 'rate-limited' | 'error'

export interface RequestAccessFormProps {
  /** Default `/api/auth/request`. */
  endpoint?: string
  /** Must match the server's `honeypotField`. Default `website`. */
  honeypotField?: string
  askName?: boolean
  askNote?: boolean
  notePlaceholder?: string
  onSubmitted?: (state: RequestState) => void
  classNames?: Partial<Record<'form' | 'field' | 'label' | 'input' | 'button' | 'message', string>>
  labels?: Partial<Record<'email' | 'name' | 'note' | 'submit' | 'submitting', string>>
}

const MESSAGES: Record<Exclude<RequestState, 'idle' | 'submitting'>, string> = {
  pending: "Thanks — we'll email you a link once someone approves it.",
  invalid: "That doesn't look like an email address.",
  'rate-limited': "That's a lot of requests. Try again in a little while.",
  error: 'Something went wrong. Try again?',
}

/**
 * The wall's second affordance, for everyone who isn't staff. Unstyled: every
 * visible string and class is a prop, because the wall's copy is exactly the
 * part each app needs to own.
 */
export function RequestAccessForm({
  endpoint = '/api/auth/request',
  honeypotField = 'website',
  askName = true,
  askNote = true,
  notePlaceholder = 'Anything that helps us place you (optional)',
  onSubmitted,
  classNames = {},
  labels = {},
}: RequestAccessFormProps) {
  const [state, setState] = useState<RequestState>('idle')

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (state === 'submitting' || state === 'pending') return
    const data = Object.fromEntries(new FormData(e.currentTarget).entries())
    setState('submitting')
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(data),
      })
      const parsed = (await res.json().catch(() => ({}))) as { status?: RequestState }
      const next: RequestState = parsed.status && parsed.status in MESSAGES ? parsed.status : res.ok ? 'pending' : 'error'
      setState(next)
      onSubmitted?.(next)
    } catch {
      setState('error')
      onSubmitted?.('error')
    }
  }

  if (state === 'pending') return <p className={classNames.message}>{MESSAGES.pending}</p>

  return (
    <form className={classNames.form} onSubmit={submit}>
      <div className={classNames.field}>
        <label className={classNames.label} htmlFor="oa-auth-email">
          {labels.email ?? 'Email'}
        </label>
        <input className={classNames.input} id="oa-auth-email" name="email" type="email" required autoComplete="email" />
      </div>

      {askName && (
        <div className={classNames.field}>
          <label className={classNames.label} htmlFor="oa-auth-name">
            {labels.name ?? 'Name'}
          </label>
          <input className={classNames.input} id="oa-auth-name" name="name" type="text" autoComplete="name" />
        </div>
      )}

      {askNote && (
        <div className={classNames.field}>
          <label className={classNames.label} htmlFor="oa-auth-note">
            {labels.note ?? 'Note'}
          </label>
          <textarea className={classNames.input} id="oa-auth-note" name="note" rows={2} placeholder={notePlaceholder} />
        </div>
      )}

      {/* Honeypot: hidden from people and assistive tech, irresistible to bots. */}
      <input
        name={honeypotField}
        type="text"
        tabIndex={-1}
        autoComplete="off"
        aria-hidden="true"
        style={{ position: 'absolute', left: '-9999px', width: 1, height: 1, opacity: 0 }}
      />

      <button className={classNames.button} type="submit" disabled={state === 'submitting'}>
        {state === 'submitting' ? (labels.submitting ?? 'Sending…') : (labels.submit ?? 'Request access')}
      </button>

      {state !== 'idle' && state !== 'submitting' && <p className={classNames.message}>{MESSAGES[state]}</p>}
    </form>
  )
}
