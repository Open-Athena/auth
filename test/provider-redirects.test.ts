// Which callback URLs a client may be sent to: exact matches for everyone,
// and a one-label pattern for preview clients only.
import { describe, expect, it } from 'vitest'
import { previewPattern, redirectAllowed, redirectUriProblem } from '../src/provider/index.js'

const PATTERN = 'https://*.proj.pages.dev/auth/cb'

describe('previewPattern', () => {
  it('reads a well-formed pattern, and nothing looser', () => {
    expect([
      PATTERN,
      'https://*.proj.pages.dev/',
      'https://*.dev/auth/cb',
      'https://*.proj.pages.dev:8443/auth/cb',
      'https://*.proj.pages.dev/auth/cb?x=1',
      'https://*.proj.pages.dev/auth/cb#x',
      'https://*.PROJ.pages.dev/auth/cb',
      'https://*.*.pages.dev/auth/cb',
      'http://*.proj.pages.dev/auth/cb',
      'https://pr-1.proj.pages.dev/auth/cb',
    ].map(previewPattern)).toEqual([
      { suffix: 'proj.pages.dev', path: '/auth/cb' },
      { suffix: 'proj.pages.dev', path: '/' },
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
    ])
  })
})

describe('redirectAllowed', () => {
  const registered = [PATTERN, 'https://app.oa.dev/auth/cb']
  it('a preview client: one branch label under the pattern, same path, nothing else', () => {
    expect([
      'https://pr-12.proj.pages.dev/auth/cb',
      'https://3f2a9c1e.proj.pages.dev/auth/cb',
      'https://app.oa.dev/auth/cb',
      'https://proj.pages.dev/auth/cb',
      'https://a.b.proj.pages.dev/auth/cb',
      'https://pr-12.proj.pages.dev/auth/cb/',
      'https://pr-12.proj.pages.dev/auth/other',
      'https://pr-12.proj.pages.dev/auth/cb?x=1',
      'https://pr-12.proj.pages.dev:8443/auth/cb',
      'https://PR-12.proj.pages.dev/auth/cb',
      'https://pr-12.proj.pages.dev/auth/./cb',
      'https://-x.proj.pages.dev/auth/cb',
      'https://pr-12.other.pages.dev/auth/cb',
      'https://pr-12.evilproj.pages.dev/auth/cb',
      'http://pr-12.proj.pages.dev/auth/cb',
      'https://u@pr-12.proj.pages.dev/auth/cb',
      PATTERN,
    ].map(uri => redirectAllowed(registered, uri, true))).toEqual([
      true, true, true,
      false, false, false, false, false, false, false, false, false, false, false, false, false, false,
    ])
  })

  it('any other client: exact matches only, so a pattern matches nothing', () => {
    expect(['https://pr-12.proj.pages.dev/auth/cb', PATTERN, 'https://app.oa.dev/auth/cb'].map(uri => redirectAllowed(registered, uri, false))).toEqual([
      false,
      false,
      true,
    ])
  })
})

describe('redirectUriProblem with patterns', () => {
  it('a pattern needs the preview allowlist, and a host on it', () => {
    const allow = { previewSuffixes: ['proj.pages.dev'] }
    expect([
      redirectUriProblem(PATTERN, ['oa.dev'], allow),
      redirectUriProblem(PATTERN, ['oa.dev']),
      redirectUriProblem('https://*.other.pages.dev/auth/cb', ['oa.dev'], allow),
      redirectUriProblem('https://*.proj.pages.dev/auth/cb?x=1', ['oa.dev'], allow),
      redirectUriProblem('https://pr-1.proj.pages.dev/auth/cb', ['oa.dev'], allow),
      redirectUriProblem('https://app.oa.dev/auth/cb', ['oa.dev'], allow),
    ]).toEqual([
      null,
      `${PATTERN}: patterns are only for preview clients, under an allowlisted host`,
      'https://*.other.pages.dev/auth/cb: patterns are only allowed under proj.pages.dev',
      'https://*.proj.pages.dev/auth/cb?x=1: a pattern is https://*.<host>/<path>, in normal form, with no port, query or fragment',
      'https://pr-1.proj.pages.dev/auth/cb: must be under oa.dev',
      null,
    ])
  })
})
