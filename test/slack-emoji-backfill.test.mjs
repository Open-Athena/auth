// The Slack emoji backfill's matching, review file and SQL (scripts/slack-emoji-backfill.mjs). Slack and wrangler
// aren't called here.
import { describe, expect, it } from 'vitest'
import { asEmojiName, parseTsv, propose, toSql, toTsv } from '../scripts/slack-emoji-backfill.mjs'

const member = (id, name, real, email, { profile = {}, ...more } = {}) => ({ id, name, profile: { real_name: real, display_name: '', email, ...profile }, ...more })
const MEMBERS = [
  member('U1', 'ryan.w', 'Ryan Williams', 'Ryan@OpenAthena.ai'),
  member('U2', 'ada', 'Ada Lovelace', 'ada@openathena.ai'),
  member('U3', 'sam1', 'Sam Smith', 'sam@openathena.ai'),
  member('U4', 'sam2', 'Sam Jones', 'sjones@openathena.ai'),
  member('U5', 'jo', 'José Núñez', 'jose@openathena.ai', { profile: { display_name: 'José N.' } }),
  member('U6', 'grace', 'Grace Hopper', 'grace@openathena.ai'),
  member('U7', 'bot', 'A Bot', 'bot@openathena.ai', { is_bot: true }),
  member('U8', 'gone', 'Gone', 'gone@openathena.ai', { deleted: true }),
  { id: 'U9', name: 'guest', profile: { real_name: 'No Email' } },
]
const EMOJI = { ryanw: 'https://x/1.png', ada: 'https://x/2.png', sam: 'https://x/3.png', josen: 'https://x/4.png', grace: 'alias:ada', party: 'https://x/5.png' }

describe('slack-emoji backfill', () => {
  it('spells a name as an emoji would', () => {
    expect(['ryan.w', 'José N.', 'Ada Lovelace', "O'Neil", undefined].map(asEmojiName)).toEqual(['ryanw', 'josen', 'adalovelace', "o'neil", ''])
  })

  it('proposes the strongest unshared match per person, skips what is already mapped, and lists the rest', () => {
    const proposal = propose({ emoji: EMOJI, members: MEMBERS, current: { 'grace@openathena.ai': ':grace:', 'ada@openathena.ai': ':old_ada:' } })
    expect(proposal).toEqual({
      rows: [
        { action: 'set', email: 'ada@openathena.ai', emoji: ':ada:', match: 'handle', slack_handle: 'ada', slack_name: 'Ada Lovelace', current: ':old_ada:' },
        { action: 'set', email: 'jose@openathena.ai', emoji: ':josen:', match: 'display name', slack_handle: 'jo', slack_name: 'José Núñez', current: '' },
        { action: 'set', email: 'ryan@openathena.ai', emoji: ':ryanw:', match: 'handle', slack_handle: 'ryan.w', slack_name: 'Ryan Williams', current: '' },
      ],
      // Grace's handle matches `:grace:`, which is already hers; the Sams share `:sam:`, so neither gets it.
      unmatched: [
        { email: 'sam@openathena.ai', handle: 'sam1', name: 'Sam Smith' },
        { email: 'sjones@openathena.ai', handle: 'sam2', name: 'Sam Jones' },
      ],
      ambiguous: [{ emoji: ':sam:', emails: ['sam@openathena.ai', 'sjones@openathena.ai'] }],
    })
  })

  it('round-trips through the review file: rows deleted, edited or added by hand, comments ignored', () => {
    const tsv = toTsv(propose({ emoji: EMOJI, members: MEMBERS }))
    const lines = tsv.trimEnd().split('\n')
    const edited = [
      lines[0],
      lines.find(l => l.startsWith('set\tada@')).replace(':ada:', ':ada_l:'),
      ...lines.filter(l => l.startsWith('#')),
      'set\tsam@openathena.ai\tsam',
      'clear\tgone@openathena.ai',
    ].join('\n')
    expect([lines[0], parseTsv(edited)]).toEqual([
      'action\temail\temoji\tmatch\tslack_handle\tslack_name\tcurrent',
      [
        { email: 'ada@openathena.ai', emoji: ':ada_l:' },
        { email: 'sam@openathena.ai', emoji: ':sam:' },
        { email: 'gone@openathena.ai', emoji: null },
      ],
    ])
  })

  it('refuses a malformed file rather than writing part of it', () => {
    const head = 'action\temail\temoji\tmatch\tslack_handle\tslack_name\tcurrent'
    expect([
      () => parseTsv('email\temoji\n'),
      () => parseTsv(`${head}\nset\tada@x.test\ttwo words`),
      () => parseTsv(`${head}\nmaybe\tada@x.test\tada`),
      () => parseTsv(`${head}\nset\t\tada`),
    ].map(f => { try { f(); return null } catch (e) { return e.message } })).toEqual([
      'expected the header: action email emoji match slack_handle slack_name current',
      'row 1: not an emoji name: "two words"',
      'row 1: action must be set or clear, not "maybe"',
      'row 1: no email',
    ])
  })

  it('writes the same upsert as the store: a row ahead of sign-in, or just the emoji', () => {
    expect(toSql([{ email: "o'neil@x.test", emoji: ':oneil:' }, { email: 'gone@x.test', emoji: null }]).trimEnd().split('\n')).toEqual([
      "INSERT INTO profiles (email, name, avatar, avatar_src, updated_at, slack_emoji) VALUES ('o''neil@x.test', NULL, NULL, 'seed-pending', 0, ':oneil:') ON CONFLICT(email) DO UPDATE SET slack_emoji = excluded.slack_emoji;",
      "INSERT INTO profiles (email, name, avatar, avatar_src, updated_at, slack_emoji) VALUES ('gone@x.test', NULL, NULL, 'seed-pending', 0, NULL) ON CONFLICT(email) DO UPDATE SET slack_emoji = excluded.slack_emoji;",
    ])
  })
})
