/**
 * A self-set profile: the display name and face a *signed-in* principal chooses
 * for themselves. The counterpart to a grant's `subject`, which is admin-owned
 * and immutable — this one is owned by the person it describes, keyed by their
 * verified email so it survives across sessions and devices.
 *
 * This stays *gating*, not a profile system: a name and an avatar, nothing
 * more. No bios, no preferences, no social graph.
 */

/** How a stored avatar was sourced — provenance for re-resolve/debug. */
export type AvatarSourceKind = 'upload' | 'url' | 'github' | 'gravatar'

export interface Profile {
  /** The verified principal (SSO email, or a magic-link-verified grant email). */
  email: string
  first: string | null
  last: string | null
  /**
   * A `data:` URI (default) or an `asset://<id>` ref — never a live remote URL,
   * so rendering it never phones a third party.
   */
  avatar: string | null
  avatarSrc: AvatarSourceKind | null
  /** Epoch seconds. Also the throttle basis for `profileMinEditIntervalS`. */
  updatedAt: number
}

/** Longest a self-asserted display-name field may be. */
export const MAX_PROFILE_NAME = 80

/**
 * A display-name field, made safe for a text node and for `initialsOf`: control
 * characters flattened to spaces, capped, re-trimmed (slicing mid-word can leave
 * a trailing space). Empty becomes `null`. Names are self-asserted labels, not
 * validated for realness — the audit log records the *email*, the real identity.
 */
export function cleanName(value: string | null | undefined): string | null {
  const t = value?.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, MAX_PROFILE_NAME).trim()
  return t || null
}
