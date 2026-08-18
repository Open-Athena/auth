import { useState } from 'react'
import { type Whoami, displayName } from './types.js'

export interface AvatarProps {
  whoami?: Whoami | null
  /**
   * A name to draw initials from, for the places that have a person but no
   * identity — an admin's request queue, most of all.
   */
  name?: string | null
  /**
   * An explicit image. Defaults to `subject.avatar` when the identity carries
   * one; falls back to initials if it fails to load.
   *
   * No Gravatar by default, on purpose: fetching one tells a third party the
   * hash of your visitor's address on every render of a page whose whole
   * premise is that access is private. An app that judges that trade worthwhile
   * passes the URL in here itself.
   */
  src?: string | null
  /** Pixels. Also the font size basis for the initials fallback. */
  size?: number
  className?: string
  /** Override the initials (default: from `displayName`). */
  initials?: string
}

/**
 * Up to two initials, code-point-safe so a name starting with an emoji or an
 * astral-plane character doesn't render half a surrogate pair.
 */
export function initialsOf(name: string | null | undefined): string {
  const words = (name ?? '').trim().split(/\s+/).filter(Boolean)
  const picked = words.length > 1 ? [words[0]!, words[words.length - 1]!] : words.slice(0, 1)
  return picked.map(w => Array.from(w)[0] ?? '').join('').toUpperCase()
}

/** A face for the chip and the request table: an image if there is one, else initials. */
export function Avatar({ whoami, name: nameProp, src, size = 24, className, initials }: AvatarProps) {
  const [broken, setBroken] = useState(false)
  const name = nameProp ?? displayName(whoami)
  const subjectAvatar = (whoami as { subject?: { avatar?: string } } | null | undefined)?.subject?.avatar
  const url = src ?? subjectAvatar ?? null
  const text = initials ?? initialsOf(name)
  const box = { width: size, height: size, borderRadius: '50%', flex: `0 0 ${size}px` } as const

  if (url && !broken) {
    return (
      <img
        className={className}
        src={url}
        alt={name ?? ''}
        width={size}
        height={size}
        style={{ ...box, objectFit: 'cover' }}
        onError={() => setBroken(true)}
        // The identity is private; don't hand the referrer to whoever hosts it.
        referrerPolicy="no-referrer"
      />
    )
  }

  if (!text) return null

  return (
    <span
      className={className}
      aria-hidden="true"
      style={{
        ...box,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: size * 0.42,
        lineHeight: 1,
      }}
    >
      {text}
    </span>
  )
}
