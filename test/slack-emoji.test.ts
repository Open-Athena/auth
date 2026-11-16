// A person's Slack emoji on their profile: set by admins and the backfill, never by the person; copied from the
// broker's claim at each sign-in (specs/done/slack-emoji-claim.md). The provider's claim and lookup are in
// provider.test.ts.
import { describe, expect, it } from 'vitest'
import { d1ProfileStore } from '../src/adapters/d1.js'
import { createGate } from '../src/core/gate.js'
import { normalizeSlackEmoji } from '../src/core/profile.js'
import type { ProfileStore } from '../src/core/store.js'
import { memoryProfileStore } from '../src/testing/index.js'
import { testDb } from './d1-shim.js'
import { memoryAudit, memoryStore } from './memory-store.js'

const ADA = 'ada@openathena.ai'

describe('normalizeSlackEmoji', () => {
  it('stores `:name:`, lower-case; anything else is not an emoji name', () => {
    expect([':ryan:', 'ryan', ' :Ryan_W: ', "+1", "o'neil", 'a-b', '::', ':two words:', ':ryan', 'x'.repeat(101), 7, null].map(normalizeSlackEmoji)).toEqual([
      ':ryan:', ':ryan:', ':ryan_w:', ':+1:', ":o'neil:", ':a-b:', null, null, ':ryan:', null, null, null,
    ])
  })
})

describe.each([
  ['memory', () => memoryProfileStore() as ProfileStore],
  ['d1', () => d1ProfileStore(testDb())],
])('%s profile store', (_, makeStore) => {
  const setup = () => {
    const profiles = makeStore()
    const gate = createGate({ store: memoryStore(), audit: memoryAudit(), secret: 'test-secret-0123456789abcdef', policy: async () => ['view'], profiles })
    return { profiles, gate }
  }

  it('an emoji set ahead of sign-in makes a row with no name or photo yet, which the first sign-in fills', async () => {
    const { profiles, gate } = setup()
    await gate.setSlackEmoji('Ada@OpenAthena.ai', 'ada')
    const before = await profiles.get(ADA)
    const subject = await gate.seedProfileFromClaims(ADA, { name: 'Ada Lovelace' }, 5_000_000)
    expect([before, subject, (await profiles.get(ADA))?.updatedAt]).toEqual([
      { email: ADA, name: null, avatar: null, avatarSrc: 'seed-pending', updatedAt: 0, slackEmoji: ':ada:' },
      { name: 'Ada Lovelace', slackEmoji: ':ada:' },
      0,
    ])
  })

  it("the person's own saves never write it, and keep it", async () => {
    const { profiles, gate } = setup()
    await gate.seedProfileFromClaims(ADA, { name: 'Ada' }, 1_000_000)
    await gate.setSlackEmoji(ADA, ':ada:')
    const auth = { kind: 'sso' as const, email: ADA, admin: false, scopes: ['view'], subject: null }
    const saved = await gate.putProfile(auth, { name: 'Ada L', slackEmoji: ':evil:' } as never, 9_000_000)
    expect([saved.ok, await profiles.get(ADA).then(p => [p?.name, p?.slackEmoji])]).toEqual([true, ['Ada L', ':ada:']])
  })

  it("the broker's claim is copied at each sign-in: set, changed, cleared by null, and left alone when absent", async () => {
    const { profiles, gate } = setup()
    const emoji = async () => (await profiles.get(ADA))?.slackEmoji ?? null
    const seen: (string | null)[] = []
    await gate.seedProfileFromClaims(ADA, { name: 'Ada', oa_slack_emoji: ':ada:' })
    seen.push(await emoji())
    await gate.seedProfileFromClaims(ADA, { name: 'Ada', oa_slack_emoji: ':ada2:' })
    seen.push(await emoji())
    // A Google sign-in carries no claim: it mustn't clear the copy.
    await gate.seedProfileFromClaims(ADA, { name: 'Ada' })
    seen.push(await emoji())
    // Junk is ignored, not stored.
    await gate.seedProfileFromClaims(ADA, { name: 'Ada', oa_slack_emoji: '<img src=x>' })
    seen.push(await emoji())
    await gate.seedProfileFromClaims(ADA, { name: 'Ada', oa_slack_emoji: null })
    seen.push(await emoji())
    expect(seen).toEqual([':ada:', ':ada2:', ':ada2:', ':ada2:', null])
  })

  it('setSlackEmoji refuses a value that is not an emoji name, and null clears', async () => {
    const { profiles, gate } = setup()
    await gate.setSlackEmoji(ADA, 'ada')
    await expect(gate.setSlackEmoji(ADA, 'two words')).rejects.toThrow('not a Slack emoji name: "two words"')
    const kept = (await profiles.get(ADA))?.slackEmoji
    await gate.setSlackEmoji(ADA, null)
    expect([kept, (await profiles.get(ADA))?.slackEmoji]).toEqual([':ada:', null])
  })
})
