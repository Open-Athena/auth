import type { ReactNode } from 'react'
import { RequestAccessForm, type RequestAccessFormProps } from './RequestAccessForm.js'

export interface SignInPanelProps {
  /** Where the SSO button goes, e.g. `/auth/sso`. Omit to hide the button. */
  signInUrl?: string
  /** Append the current path so SSO returns the visitor where they started. Default true. */
  withNext?: boolean
  title?: ReactNode
  hint?: ReactNode
  signInLabel?: ReactNode
  /** Render the request-access form. `true` for defaults, or pass props. */
  requestAccess?: boolean | RequestAccessFormProps
  children?: ReactNode
  classNames?: Partial<Record<'root' | 'title' | 'hint' | 'button' | 'divider', string>>
}

function withNextParam(url: string): string {
  if (typeof window === 'undefined') return url
  const next = window.location.pathname + window.location.search
  const sep = url.includes('?') ? '&' : '?'
  return `${url}${sep}next=${encodeURIComponent(next)}`
}

/**
 * The wall. Two affordances — SSO for staff, request-access for everyone else —
 * because the alternative for an external is emailing an admin and waiting,
 * which is how share links end up forwarded instead of minted.
 *
 * A revoked or expired link should land *here*, not on a bare 403: the person
 * who legitimately lost access self-serves, and the person who shouldn't have
 * it hits a door that names itself.
 */
export function SignInPanel({
  signInUrl,
  withNext = true,
  title = 'This page is private',
  hint,
  signInLabel = 'Sign in',
  requestAccess,
  children,
  classNames = {},
}: SignInPanelProps) {
  const href = signInUrl && withNext ? withNextParam(signInUrl) : signInUrl

  return (
    <div className={classNames.root}>
      {title && <h1 className={classNames.title}>{title}</h1>}
      {hint && <p className={classNames.hint}>{hint}</p>}
      {href && (
        <a className={classNames.button} href={href}>
          {signInLabel}
        </a>
      )}
      {children}
      {requestAccess && (
        <>
          {href && <div className={classNames.divider} />}
          <RequestAccessForm {...(requestAccess === true ? {} : requestAccess)} />
        </>
      )}
    </div>
  )
}
