# An imported photo should fill any avatar the person hasn't explicitly set

*(Requested from `jobs.oa.dev`, `~/c/oa/jobs`, 2026-11-06.)*

## Context

`seedProfileFromClaims` only touches a new row, or one marked `AVATAR_SEED_PENDING`. `putProfile` writes `avatarSrc: null` both for "cleared my photo" and for a save that never mentioned a photo. So someone who saves only a name under Profile, before their first sign-in with a `picture`, keeps initials for good.

The rule the user wants: **the IdP's photo is the fallback whenever no avatar has been set explicitly.** Saving a name isn't a decision about the photo.

## Requirements

- `putProfile` with no `avatar` in the input must leave the row eligible for seeding: a new row gets `AVATAR_SEED_PENDING`, and an existing pending row stays pending (`existing?.avatarSrc` already does this).
- An explicit choice still wins:
  - A photo the person set is never overwritten.
  - **An explicit removal (`avatar: null`) stays respected.** Otherwise nobody could get rid of an imported photo, because the next sign-in would bring it back. If you'd rather give removal its own marker, that's fine, but it must be distinguishable from "never set".
- `<ProfilePanel>` must send `avatar` only when the person actually changed it. Check what it sends today: if a name-only save posts `avatar: null`, it reads as a removal and the fix above won't help.
- A name typed before the first seed survives the seed. The `existing` branch already keeps the name.
- Pending must not leak out as a real source: anything rendering `avatarSrc` should treat it as "no photo".

## Tests

- Name-only save, then sign-in with `picture`: the photo is copied and the name kept.
- Removing a photo, then sign-in with `picture`: stays without a photo.
- Set photo, then sign-in with `picture`: unchanged.
- Through `<ProfilePanel>`: editing only the name sends no `avatar`.

## Existing rows

Rows already saved with `avatar: null, avatarSrc: null` can't be told apart: they could be removals or name-only saves. Leaving them alone is the safe default. Say in the spec's final state if you find a way to do better.

## Downstream

`jobs` is on `0.1.0-dist.2ea9c4f` (commit `1b2b3bb`, not deployed yet, waiting on the user). When a dist build has this, tell the `jobs` session the SHA.
