import type { ReactNode } from 'react'

/**
 * How the button looks (ui.css, `.oa-signin-<variant>`), from the Open Athena brand guidelines' palette:
 * - `taupe` (default): taupe `#A99B8D`, the mark and label in OA black.
 * - `neutral`: Google's own recipe, a plain button (white, or near-black under a dark color scheme) with the mark in its
 *   colors.
 * - `blue`: OA blue `#224A82`, the mark on a white tile, the way Google's blue button carries its logo.
 * Each is a set of `--oa-signin-*` variables, so a host can restyle any of them.
 */
export type OaSignInVariant = 'taupe' | 'neutral' | 'blue'

/** Whose button this is: OA's by default. Another org passes its own name and mark (and its colors in CSS). */
export interface OaSignInBrand {
  /** "Sign in with <name>". */
  name: string
  /** About 22px square; color it with `currentColor` or the `--oa-signin-*` variables. */
  mark: ReactNode
}

/** A returning visitor, shown Google's way: their face, "Continue as <first name>" over their address, the mark last. */
export interface OaSignInAccount {
  email: string
  name?: string | null
  avatar?: string | null
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

/** The Open Athena mark (the logo's stems and rings, from "Open Athena Logo Color.svg"). */
export function OaMark({ size = 22 }: { size?: number }) {
  return (
    <svg className="oa-signin-mark" width={size} height={size} viewBox="1950 0 1430 1383" aria-hidden="true" focusable="false">
      <g className="oa-signin-ring" fillRule="evenodd">
        <path d="M3098.84 76.02C3037.77 76.02 2988.22 125.57 2988.22 186.64C2988.22 247.72 3037.77 297.27 3098.84 297.27C3159.92 297.27 3209.46 247.72 3209.46 186.64C3209.46 125.57 3159.92 76.02 3098.84 76.02ZM2912.2 186.64C2912.2 83.57 2995.77 0 3098.84 0C3201.92 0 3285.49 83.57 3285.49 186.64C3285.49 289.72 3201.92 373.29 3098.84 373.29C2995.77 373.29 2912.2 289.72 2912.2 186.64Z" />
        <path d="M3191.49 653.98C3130.41 653.98 3080.87 703.52 3080.87 764.6C3080.87 825.68 3130.41 875.22 3191.49 875.22C3252.57 875.22 3302.11 825.68 3302.11 764.6C3302.11 703.52 3252.57 653.98 3191.49 653.98ZM3004.85 764.6C3004.85 661.52 3088.41 577.95 3191.49 577.95C3294.57 577.95 3378.14 661.52 3378.14 764.6C3378.14 867.68 3294.57 951.24 3191.49 951.24C3088.41 951.24 3004.85 867.68 3004.85 764.6Z" />
        <path d="M2149.71 381.03C2088.64 381.03 2039.09 430.57 2039.09 491.65C2039.09 552.72 2088.64 602.27 2149.71 602.27C2210.79 602.27 2260.34 552.72 2260.34 491.65C2260.34 430.57 2210.79 381.03 2149.71 381.03ZM1963.07 491.65C1963.07 388.57 2046.64 305 2149.71 305C2252.79 305 2336.36 388.57 2336.36 491.65C2336.36 594.72 2252.79 678.29 2149.71 678.29C2046.64 678.29 1963.07 594.77 1963.07 491.65Z" />
      </g>
      <g className="oa-signin-stem">
        <path d="M2536.08 609.09C2536.08 494.96 2452.22 400.39 2342.75 383.67C2324.83 351.71 2299.21 324.66 2268.41 305.05H2308.01C2475.91 305.05 2612.05 441.19 2612.05 609.09V1141.92C2612.05 1271.86 2506.71 1377.2 2376.77 1377.2V1301.18C2464.71 1301.18 2536.03 1229.86 2536.03 1141.92V609.09H2536.08Z" />
        <path d="M3009.56 578C2918.73 578 2837.23 617.79 2781.54 680.94V304.04C2781.54 221.24 2825.7 148.73 2891.73 108.8C2908.35 64.63 2938.63 27.2 2977.5 1.68C2824.69 17.73 2705.56 146.95 2705.56 304.04V1141.92C2705.56 1271.86 2810.9 1377.2 2940.84 1377.2V1301.18C2852.9 1301.18 2781.59 1229.86 2781.59 1141.92V882.05C2781.59 759.36 2878.42 659.36 2999.8 654.22C3017.63 623.32 3042.71 597.13 3072.75 578H3009.56Z" />
      </g>
    </svg>
  )
}

export const OA_BRAND: OaSignInBrand = { name: 'OA', mark: <OaMark /> }

/**
 * "Sign in with OA": a link to the app's broker sign-in (`/auth/oa`), styled to sit beside Google's button (40px tall,
 * mark at the start, label centered). Import `@open-athena/auth/react/ui.css` for its styles.
 */
export function OaSignInButton({ href, variant = 'taupe', label, account, brand = OA_BRAND, className }: OaSignInButtonProps) {
  const classes = ['oa-signin', `oa-signin-${variant}`, account ? 'oa-signin-account' : null, className].filter(Boolean).join(' ')
  const mark = <span className="oa-signin-logo">{brand.mark}</span>
  if (account) {
    const first = account.name?.trim().split(/\s+/)[0] || null
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
