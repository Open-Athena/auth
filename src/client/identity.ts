/** The two identity shapes a gate's `/whoami` returns, and where to ask for them. */
import type { Subject } from '../core/types.js'

/** Where a gate's `/whoami` is mounted. */
export interface WhoamiSource {
  endpoint?: string
}

export const DEFAULT_WHOAMI_ENDPOINT = '/api/auth/whoami'

export interface SsoWhoami {
  kind: 'sso'
  email: string
  admin: boolean
  scopes: string[]
  /** The principal's self-set profile, or null (initials). Carried so `<Avatar>`/`displayName` render staff faces without a render-side change. */
  subject: Subject | null
  /** Retained-login mode only: the browser's selection context, sent back as `X-OA-Selection-Context` on mutations. */
  selection?: string
}

export interface GrantWhoami {
  kind: 'grant'
  /** The grant's id — the session's subject is `g:<id>`. Not a secret. */
  id: string
  subject: Subject | null
  email: string | null
  scopes: string[]
  admin: false
  expiresAt: number | null
  /** An anonymous link: `subject` and `email` are withheld from the holder. `pseudonym(id)` gives it a stable name. */
  anon?: true
  /** Retained-login mode only: see `SsoWhoami.selection`. */
  selection?: string
}

/** What a gate's `/whoami` returns: an email session, or a share-link session. */
export type Whoami = SsoWhoami | GrantWhoami

const ADJECTIVES = [
  'Amber', 'Bold', 'Brisk', 'Calm', 'Clever', 'Coral', 'Cosmic', 'Curious', 'Dapper', 'Eager', 'Fabled', 'Gentle',
  'Glad', 'Golden', 'Hardy', 'Hidden', 'Humble', 'Indigo', 'Jade', 'Jolly', 'Keen', 'Kind', 'Lively', 'Lucky',
  'Lunar', 'Mellow', 'Merry', 'Mighty', 'Misty', 'Modest', 'Noble', 'Nimble', 'Olive', 'Patient', 'Plucky', 'Polar',
  'Quiet', 'Quick', 'Rapid', 'Rosy', 'Ruby', 'Rustic', 'Sage', 'Scarlet', 'Silver', 'Sleepy', 'Snowy', 'Solar',
  'Spry', 'Steady', 'Stormy', 'Sunny', 'Swift', 'Teal', 'Tidy', 'Topaz', 'Velvet', 'Vivid', 'Wandering', 'Warm',
  'Wise', 'Witty', 'Woolly', 'Zesty',
] as const
const ANIMALS = [
  'Albatross', 'Alpaca', 'Armadillo', 'Axolotl', 'Badger', 'Beaver', 'Bison', 'Capybara', 'Caribou', 'Cheetah',
  'Chinchilla', 'Coyote', 'Crane', 'Dingo', 'Dolphin', 'Dormouse', 'Egret', 'Falcon', 'Ferret', 'Finch', 'Fox',
  'Gazelle', 'Gecko', 'Gibbon', 'Heron', 'Hedgehog', 'Ibex', 'Ibis', 'Jackal', 'Jaguar', 'Kestrel', 'Koala', 'Lemur',
  'Lynx', 'Marmot', 'Meerkat', 'Mongoose', 'Moose', 'Narwhal', 'Ocelot', 'Otter', 'Panda', 'Pangolin', 'Pelican',
  'Penguin', 'Puffin', 'Quail', 'Quokka', 'Raccoon', 'Raven', 'Salamander', 'Seal', 'Sparrow', 'Stoat', 'Tapir',
  'Tortoise', 'Toucan', 'Vole', 'Walrus', 'Weasel', 'Wombat', 'Wren', 'Yak', 'Zebra',
] as const

/**
 * A stable "Anonymous Capybara"-style name for an anonymous link, derived from
 * its grant id: every session of one link gets the same name, and nothing is stored.
 */
export function pseudonym(grantId: string): string {
  // FNV-1a, 32-bit: deterministic and synchronous, so a render can call it.
  let h = 0x811c9dc5
  for (let i = 0; i < grantId.length; i++) h = Math.imul(h ^ grantId.charCodeAt(i), 0x01000193) >>> 0
  return `${ADJECTIVES[h % ADJECTIVES.length]} ${ANIMALS[(h >>> 6) % ANIMALS.length]}`
}

/**
 * Best available human label: the *person*, then an email, or null for an
 * anonymous link (unnamed, or `anon`; see `pseudonym` for the latter). A link's
 * memo is not a candidate: it's the minter's note, and a gate doesn't send it to the link session.
 */
export function displayName(whoami: Whoami | null | undefined): string | null {
  if (!whoami) return null
  if (whoami.kind === 'grant') {
    if (whoami.anon) return null
    const subject: Subject = whoami.subject ?? {}
    return subject.name || subject.email || whoami.email || null
  }
  // A self-set name wins over the bare email: it's who the person said they are.
  return whoami.subject?.name || whoami.email || null
}

export function hasScope(whoami: Whoami | null | undefined, scope: string): boolean {
  if (!whoami) return false
  return whoami.scopes.includes('*') || whoami.scopes.includes(scope)
}
