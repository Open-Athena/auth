/**
 * The social layer (specs/share-links-and-audit.md §5). No ACL fixes the
 * failure modes of sharing sensitive material by link, so these are the
 * normative controls: say that access is logged, and make the page attributable.
 */
import type { CSSProperties, ReactNode } from 'react'
import { type Whoami, displayName } from './types.js'

export interface AccessNoticeProps {
  whoami: Whoami | null | undefined
  /** Set false when `logViews` is off, so the copy stays true. */
  logged?: boolean
  /** Optional honest extra: "you've viewed this 4 times". */
  viewCount?: number | null
  className?: string
  children?: ReactNode
}

/**
 * *"Private link for Bob Smith · access is logged"* — the single
 * highest-leverage feature here. It sets accurate expectations, so nobody is
 * betrayed by discovering the log later, and it empirically dampens casual
 * forwarding harder than technical controls do, because the recipient now knows
 * the link is attributable to them.
 *
 * An unnamed link still gets the notice, without the name. Dropping it there
 * would silence the disclosure in exactly the case where the visitor is least
 * identifiable and the logging is least expected — which is the promise above,
 * broken quietly.
 */
export function AccessNotice({ whoami, logged = true, viewCount = null, className, children }: AccessNoticeProps) {
  if (!whoami) return null
  const name = displayName(whoami)
  return (
    <p className={className}>
      {name ? `Private link for ${name}` : 'Private link'}
      {logged && ' · access is logged'}
      {viewCount !== null && ` · you've viewed this ${viewCount} ${viewCount === 1 ? 'time' : 'times'}`}
      {children}
    </p>
  )
}

export interface WatermarkProps {
  whoami: Whoami | null | undefined
  /** Overrides the name derived from `whoami`. */
  text?: string
  /** Repetitions across the layer. Default 60. */
  count?: number
  className?: string
}

/**
 * The data-room convention: render the recipient's name across the page so
 * screenshots stay attributable. Only the styles that make it *work* are inline
 * (it must not intercept clicks, and it must cover the viewport); colour,
 * opacity and rotation are left to `className`, since that's branding.
 */
export function Watermark({ whoami, text, count = 60, className }: WatermarkProps) {
  const label = text ?? displayName(whoami)
  if (!label) return null
  const style: CSSProperties = {
    position: 'fixed',
    inset: 0,
    pointerEvents: 'none',
    userSelect: 'none',
    overflow: 'hidden',
    zIndex: 9999,
  }
  return (
    <div aria-hidden="true" className={className} style={style}>
      {Array.from({ length: count }, (_, i) => (
        <span key={i}>{label} </span>
      ))}
    </div>
  )
}
