import { describe, expect, it } from 'vitest'
import { adminPolicy, anyEmailPolicy, domainPolicy, firstMatch } from '../src/core/policy.js'

const run = async (policy: ReturnType<typeof domainPolicy>, emails: string[]) =>
  Promise.all(emails.map(e => policy(e)))

describe('domainPolicy', () => {
  it('matches the domain case-insensitively, with or without a leading @', async () => {
    const p = domainPolicy(['@openathena.ai', 'Example.COM'], ['internal'])
    expect(await run(p, ['a@openathena.ai', 'b@OPENATHENA.AI', 'c@example.com', 'd@elsewhere.org'])).toEqual([
      ['internal'],
      ['internal'],
      ['internal'],
      null,
    ])
  })

  it('does not match a domain that merely ends with an allowed one', async () => {
    const p = domainPolicy(['openathena.ai'], ['internal'])
    expect(await run(p, ['evil@notopenathena.ai', 'evil@openathena.ai.attacker.test'])).toEqual([null, null])
  })

  it('uses the last @ so sub-addressed locals cannot spoof the domain', async () => {
    const p = domainPolicy(['openathena.ai'], ['internal'])
    expect(await run(p, ['"a@openathena.ai"@evil.test'])).toEqual([null])
  })
})

describe('adminPolicy', () => {
  it('grants the wildcard scope to listed admins only', async () => {
    const p = adminPolicy(['Boss@openathena.ai'])
    expect(await run(p, ['boss@openathena.ai', 'other@openathena.ai'])).toEqual([['*'], null])
  })
})

describe('anyEmailPolicy', () => {
  it('accepts every authenticated identity', async () => {
    expect(await run(anyEmailPolicy(['read']), ['anyone@anywhere.test'])).toEqual([['read']])
  })
})

describe('firstMatch', () => {
  it('returns the first non-null result and does not merge scopes', async () => {
    const p = firstMatch(adminPolicy(['boss@openathena.ai']), domainPolicy(['openathena.ai'], ['internal']))
    expect(await run(p, ['boss@openathena.ai', 'staff@openathena.ai', 'stranger@x.test'])).toEqual([
      ['*'],
      ['internal'],
      null,
    ])
  })
})
