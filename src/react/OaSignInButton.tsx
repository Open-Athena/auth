import type { ReactNode } from 'react'
import { OA_MARK, firstName, oaSignInClasses, type OaSignInAccount, type OaSignInVariant } from '../signin/index.js'

export type { OaSignInAccount, OaSignInVariant }

/** Whose button this is: OA's by default. Another org passes its own name and mark (and its colors in CSS). */
export interface OaSignInBrand {
  /** "Sign in with <name>". */
  name: string
  /** About 22px square; color it with `currentColor` or the `--oa-signin-*` variables. */
  mark: ReactNode
}

export interface OaSignInButtonProps {
  /** The sign-in start, e.g. `/auth/oa` (append `?next=` yourself). */
  href: string
  variant?: OaSignInVariant
  /** Default "Sign in with <brand name>". */
  label?: string
  account?: OaSignInAccount | null
  brand?: OaSignInBrand
  className?: string
}

/** The Open Athena mark (`OA_MARK`). */
export function OaMark({ size = 22 }: { size?: number }) {
  return (
    <svg className="oa-signin-mark" width={size} height={size} viewBox={OA_MARK.viewBox} aria-hidden="true" focusable="false">
      <g className="oa-signin-ring" fillRule="evenodd">{OA_MARK.rings.map(d => <path key={d} d={d} />)}</g>
      <g className="oa-signin-stem">{OA_MARK.stems.map(d => <path key={d} d={d} />)}</g>
    </svg>
  )
}

export const OA_BRAND: OaSignInBrand = { name: 'OA', mark: <OaMark /> }

/**
 * "Sign in with OA": a link to the app's broker sign-in (`/auth/oa`), styled to sit beside Google's button (40px tall,
 * mark at the start, label centered). Import `@open-athena/auth/react/ui.css` for its styles. `variant`: see
 * `OaSignInVariant` (`/signin`, which has the same button as an HTML string).
 */
export function OaSignInButton({ href, variant = 'taupe', label, account, brand = OA_BRAND, className }: OaSignInButtonProps) {
  const classes = oaSignInClasses(variant, !!account, className)
  const mark = <span className="oa-signin-logo">{brand.mark}</span>
  if (account) {
    const first = firstName(account)
    return (
      <a className={classes} href={href}>
        {account.avatar
          ? <img className="oa-signin-avatar" src={account.avatar} alt="" referrerPolicy="no-referrer" />
          : <span className="oa-signin-avatar" aria-hidden="true">{(first ?? account.email).charAt(0).toUpperCase()}</span>}
        <span className="oa-signin-who">
          <span className="oa-signin-name">Continue as {first ?? account.email}</span>
          {first && <span className="oa-signin-email">{account.email}</span>}
        </span>
        {mark}
      </a>
    )
  }
  return (
    <a className={classes} href={href}>
      {mark}
      <span className="oa-signin-label">{label ?? `Sign in with ${brand.name}`}</span>
      <span className="oa-signin-spacer" aria-hidden="true" />
    </a>
  )
}
