/**
 * A self-set profile: the display name and face a *signed-in* principal chooses
 * for themselves. The counterpart to a grant's `subject`, which is admin-owned
 * and immutable — this one is owned by the person it describes, keyed by their
 * verified email so it survives across sessions and devices.
 *
 * This stays *gating*, not a profile system: a name and an avatar, nothing
 * more. No bios, no preferences, no social graph.
 */

/**
 * On a row with no avatar: nobody has made a choice about the photo (a seed got
 * none, or the person has only saved a name), so a sign-in may still fill it in.
 * Any other row without one (`avatarSrc: null`) is left alone, because that's
 * what someone removing their photo looks like. Not a real source: it says there
 * is no photo yet.
 */
export const AVATAR_SEED_PENDING = 'seed-pending'

/** How a stored avatar was sourced — provenance for re-resolve/debug — or `AVATAR_SEED_PENDING`. */
export type AvatarSourceKind = 'upload' | 'url' | 'site' | 'github' | 'gravatar' | 'bluesky' | 'mastodon' | typeof AVATAR_SEED_PENDING

export interface Profile {
  /** The verified principal (SSO email, or a magic-link-verified grant email). */
  email: string
  name: string | null
  /**
   * A `data:` URI (default) or an `asset://<id>` ref — never a live remote URL,
   * so rendering it never phones a third party.
   */
  avatar: string | null
  avatarSrc: AvatarSourceKind | null
  /** Epoch seconds. Also the throttle basis for `profileMinEditIntervalS`. */
  updatedAt: number
  /**
   * The person's custom Slack emoji (`:name:`), or null. Not self-set: broker admins and the backfill set it
   * (`ProfileStore.setSlackEmoji`), and an app copies it from the broker's `oa_slack_emoji` claim. `put` never writes
   * it, so a person saving their profile can't change it. Absent on a store that predates it.
   */
  slackEmoji?: string | null
}

/** A Slack emoji name as stored: lower-case, colon-wrapped. */
export const SLACK_EMOJI = /^:[a-z0-9_+'-]{1,100}:$/

/** `name` or `:name:` as stored (`:name:`), or null if it isn't a Slack emoji name. */
export function normalizeSlackEmoji(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const bare = value.trim().toLowerCase().replace(/^:|:$/g, '')
  const wrapped = `:${bare}:`
  return SLACK_EMOJI.test(wrapped) ? wrapped : null
}

/** Longest a self-asserted display name may be. */
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
