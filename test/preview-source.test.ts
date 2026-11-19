// A preview client's PR source (specs/done/preview-pr-context.md): its label template, its validation, and the
// broker's own GitHub lookup.
import { describe, expect, it } from 'vitest'
import { githubPreviewPrs, prNumberFor, previewSourceProblem, readPr } from '../src/provider/preview-source.js'

const SOURCE = { provider: 'github', repo: 'Open-Athena/disky', label: 'pr-{n}' } as const

describe('previewSourceProblem', () => {
  it('takes a GitHub repo and a label template that forms a DNS label for every PR', () => {
    const cases: unknown[] = [
      SOURCE,
      { ...SOURCE, label: '{n}-preview' },
      { ...SOURCE, label: 'pr{n}x' },
      null,
      { ...SOURCE, provider: 'gitlab' },
      { ...SOURCE, extra: 1 },
      { ...SOURCE, repo: 'disky' },
      { ...SOURCE, repo: 'Open-Athena/disky/x' },
      { ...SOURCE, repo: 'Open-Athena/..' },
      { ...SOURCE, label: 'pr' },
      { ...SOURCE, label: 'pr-{n}-{n}' },
      { ...SOURCE, label: 'PR-{n}' },
      { ...SOURCE, label: 'pr.{n}' },
      { ...SOURCE, label: '-{n}' },
      { ...SOURCE, label: '{n}-' },
      { ...SOURCE, label: 'pr--{n}' },
      { ...SOURCE, label: `${'a'.repeat(55)}{n}` },
    ]
    expect(cases.map(previewSourceProblem)).toEqual([
      null,
      null,
      null,
      'a source is { provider, repo, label }',
      "provider: only 'github'",
      'unexpected field: extra',
      'repo: owner/name',
      'repo: owner/name',
      'repo: owner/name',
      'label: exactly one {n}',
      'label: exactly one {n}',
      'label: lower-case letters, digits and hyphens around {n}',
      'label: lower-case letters, digits and hyphens around {n}',
      "label: no leading, trailing or doubled hyphens (they can't form every PR's host)",
      "label: no leading, trailing or doubled hyphens (they can't form every PR's host)",
      "label: no leading, trailing or doubled hyphens (they can't form every PR's host)",
      'label: too long for a DNS label',
    ])
  })
})

describe('prNumberFor', () => {
  it("reads PR n from the host's first label, and nothing else", () => {
    const hosts = ['pr-9.oa-r2-usage.pages.dev', 'pr-123.x.dev', 'dev.oa-r2-usage.pages.dev', 'pr-.x', 'pr-09.x', 'pr-0.x', 'pr-9a.x', 'x.pr-9.x', 'pr-1234567890.x']
    expect([...hosts.map(h => prNumberFor('pr-{n}', h)), prNumberFor('{n}-preview', '42-preview.x'), prNumberFor('p{n}x', 'p7x.x')]).toEqual([
      9, 123, null, null, null, null, null, null, null, 42, 7,
    ])
  })
})

describe('readPr', () => {
  const body = (over: Record<string, unknown> = {}) => ({
    number: 9, title: 't', state: 'open', draft: false, merged_at: null, updated_at: '2026-11-18T20:14:03Z',
    user: { login: 'u', avatar_url: 'https://avatars.githubusercontent.com/u/1' },
    head: { ref: 'h', sha: 's', repo: { full_name: 'Open-Athena/disky' } }, base: { ref: 'b' }, ...over,
  })
  it("maps GitHub's state, draft and merge into one state, and refuses what isn't PR n", () => {
    expect([
      readPr('Open-Athena/disky', 9, body())?.state,
      readPr('Open-Athena/disky', 9, body({ draft: true }))?.state,
      readPr('Open-Athena/disky', 9, body({ state: 'closed' }))?.state,
      readPr('Open-Athena/disky', 9, body({ state: 'closed', merged_at: '2026-11-19T00:00:00Z' }))?.state,
      readPr('Open-Athena/disky', 8, body()),
      readPr('Open-Athena/disky', 9, body({ head: null })),
      readPr('Open-Athena/disky', 9, null),
    ]).toEqual(['open', 'draft', 'closed', 'merged', null, null, null])
    expect(readPr('Open-Athena/disky', 9, body())).toEqual({
      repo: 'Open-Athena/disky',
      number: 9,
      title: 't',
      author: { login: 'u', avatarUrl: 'https://avatars.githubusercontent.com/u/1' },
      head: { ref: 'h', sha: 's', repo: 'Open-Athena/disky' },
      base: { ref: 'b' },
      state: 'open',
      updatedAt: '2026-11-18T20:14:03Z',
    })
  })
})

describe('githubPreviewPrs', () => {
  function setup(token?: string) {
    let clock = 0
    const answers: (number | Error)[] = []
    const calls: [string, Record<string, string>][] = []
    const fetch = (async (url: string, init?: RequestInit) => {
      calls.push([url, Object.fromEntries(new Headers(init?.headers))])
      const a = answers.shift() ?? 200
      if (a instanceof Error) throw a
      return a === 200 ? Response.json({ number: 9, title: 't', state: 'open', updated_at: 'x', user: { login: 'u' }, head: { ref: 'h', sha: 's', repo: null }, base: { ref: 'b' } }) : new Response('{}', { status: a })
    }) as typeof globalThis.fetch
    const prs = githubPreviewPrs({ fetch, now: () => clock, ...(token ? { token } : {}) })
    return { prs, answers, calls, at: (s: number) => { clock = s * 1000 } }
  }

  it('asks GitHub with its own token, and reuses an answer for 60 s', async () => {
    const t = setup('test-token')
    const first = await t.prs(SOURCE, 9)
    t.at(59)
    await t.prs(SOURCE, 9)
    t.at(60)
    await t.prs(SOURCE, 9)
    expect([first.status, t.calls]).toEqual([
      'found',
      [0, 1].map(() => ['https://api.github.com/repos/Open-Athena/disky/pulls/9', {
        accept: 'application/vnd.github+json',
        authorization: 'Bearer test-token',
        'user-agent': 'oa-auth-broker',
        'x-github-api-version': '2022-11-28',
      }]),
    ])
  })

  it("caches a missing PR, but not a failure, and doesn't serve a stale answer when GitHub fails", async () => {
    const t = setup()
    t.answers.push(404, 500, new Error('network'), 403)
    const results = [await t.prs(SOURCE, 9), await t.prs(SOURCE, 9)]
    t.at(60)
    results.push(await t.prs(SOURCE, 9), await t.prs(SOURCE, 9), await t.prs(SOURCE, 9), await t.prs(SOURCE, 9))
    expect([results.map(r => r.status), t.calls.length, t.calls[0]![1].authorization]).toEqual([
      ['missing', 'missing', 'unavailable', 'unavailable', 'unavailable', 'found'],
      5,
      undefined,
    ])
  })
})
