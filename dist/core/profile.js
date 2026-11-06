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
export const AVATAR_SEED_PENDING = 'seed-pending';
/** Longest a self-asserted display name may be. */
export const MAX_PROFILE_NAME = 80;
/**
 * A display-name field, made safe for a text node and for `initialsOf`: control
 * characters flattened to spaces, capped, re-trimmed (slicing mid-word can leave
 * a trailing space). Empty becomes `null`. Names are self-asserted labels, not
 * validated for realness — the audit log records the *email*, the real identity.
 */
export function cleanName(value) {
    const t = value?.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, MAX_PROFILE_NAME).trim();
    return t || null;
}
