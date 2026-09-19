import type { ReactNode } from 'react'
import { EmailCodeForm, type EmailCodeFormProps } from './EmailCodeForm.js'
import { RequestAccessForm, type RequestAccessFormProps } from './RequestAccessForm.js'

export interface SignInPanelProps {
  /**
   * The primary affordance: "Continue with Google" → an immediate redirect to
   * the OIDC start Function (e.g. `/auth/google`). Google's picker handles
   * identity; the app checks its allowlist when the id_token comes back.
   */
  googleUrl?: string
  googleLabel?: ReactNode
  /**
   * A generic SSO button (e.g. CF Access `/auth/sso`). Kept for Tier-1 apps and
   * back-compat; most consumers use `googleUrl` instead.
   */
  signInUrl?: string
  /** Append the current path so a redirect returns the visitor where they started. Default true. */
  withNext?: boolean
  /**
   * The secondary affordance: sign in with an emailed code, for addresses that
   * can't use Google. `true` for defaults, or pass `EmailCodeForm` props.
   */
  emailAuth?: boolean | EmailCodeFormProps
  /** Refetch `useWhoami` after an in-page sign-in (email code / One Tap). */
  onSignedIn?: () => void
  title?: ReactNode
  hint?: ReactNode
  signInLabel?: ReactNode
  /** Render the request-access form. `true` for defaults, or pass props. */
  requestAccess?: boolean | RequestAccessFormProps
  children?: ReactNode
  classNames?: Partial<Record<'root' | 'title' | 'hint' | 'button' | 'googleButton' | 'divider', string>>
}

function withNextParam(url: string): string {
  if (typeof window === 'undefined') return url
  const next = window.location.pathname + window.location.search
  const sep = url.includes('?') ? '&' : '?'
  return `${url}${sep}next=${encodeURIComponent(next)}`
}

/**
 * The address a denied sign-in redirected back with (`/?denied=<email>`). Google
 * (or an email link) verified it, so pre-filling request-access with it means an
 * admin approves an address that was *proven*, not merely typed.
 */
export function deniedEmail(): string | undefined {
  if (typeof window === 'undefined') return undefined
  return new URL(window.location.href).searchParams.get('denied') ?? undefined
}

/**
 * The wall. Google-first (one button, no typing), with two fallbacks — an
 * emailed code for the non-Google tail, and request-access for everyone the
 * allowlist doesn't yet know. A revoked or expired link should land *here*, not
 * on a bare 403: the person who legitimately lost access self-serves, and the
 * person who shouldn't have it hits a door that names itself.
 */
export function SignInPanel({
  googleUrl,
  googleLabel = 'Continue with Google',
  signInUrl,
  withNext = true,
  emailAuth,
  onSignedIn,
  title = 'This page is private',
  hint,
  signInLabel = 'Sign in',
  requestAccess,
  children,
  classNames = {},
}: SignInPanelProps) {
  const google = googleUrl && withNext ? withNextParam(googleUrl) : googleUrl
  const href = signInUrl && withNext ? withNextParam(signInUrl) : signInUrl
  const denied = deniedEmail()
  const anyPrimary = Boolean(google || href)

  const emailProps: EmailCodeFormProps = {
    ...(denied ? { defaultEmail: denied } : {}),
    ...(onSignedIn ? { onSignedIn } : {}),
    ...(emailAuth === true ? {} : emailAuth),
  }
  const requestProps: RequestAccessFormProps = {
    ...(denied ? { defaultEmail: denied } : {}),
    ...(requestAccess === true ? {} : requestAccess),
  }

  return (
    <div className={classNames.root}>
      {title && <h1 className={classNames.title}>{title}</h1>}
      {hint && <p className={classNames.hint}>{hint}</p>}
      {google && (
        <a className={classNames.googleButton ?? classNames.button} href={google}>
          {googleLabel}
        </a>
      )}
      {href && (
        <a className={classNames.button} href={href}>
          {signInLabel}
        </a>
      )}
      {emailAuth && (
        <>
          {anyPrimary && <div className={classNames.divider} />}
          <EmailCodeForm {...emailProps} />
        </>
      )}
      {children}
      {requestAccess && (
        <>
          {(anyPrimary || emailAuth) && <div className={classNames.divider} />}
          <RequestAccessForm {...requestProps} />
        </>
      )}
    </div>
  )
}
