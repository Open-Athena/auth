// A preview client's PR source (specs/done/preview-pr-context.md): its label template, its validation, and the
// broker's own GitHub lookup.
import { describe, expect, it } from 'vitest'
import { githubPreviewPrs, prNumberFor, previewRecord, previewSourceProblem, readPr } from '../src/provider/preview-source.js'

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

const HOST = 'pr-9.oa-r2-usage.pages.dev'
const HEAD = 'a'.repeat(40)
const OLD = 'b'.repeat(40)
/** A deployment record as disky's `cf-preview` leaves one (`over` on top; `payload` merged). */
const record = (id: number, over: Record<string, any> = {}) => ({
  id,
  environment: 'preview/r2',
  creator: { login: 'github-actions[bot]' },
  created_at: '2026-11-19T02:04:03Z',
  ...over,
  payload: { protocol: 'cf-preview-v1', repository: 'Open-Athena/disky', target: 'r2', pr: 9, hostname: HOST, sha: HEAD, verified_sha: HEAD, ...over.payload },
})

describe('previewRecord', () => {
  it("takes the newest record of this PR at this host by the preview workflow, and nobody else's", () => {
    const list = [
      { id: 1, environment: 'r2-preview', creator: { login: 'someone' }, payload: {} },
      record(2, { creator: { login: 'someone' } }),
      record(3, { payload: { protocol: 'other' } }),
      record(4, { payload: { pr: 10 } }),
      record(5, { payload: { hostname: 'pr-9.elsewhere.pages.dev' } }),
      record(6, { payload: { repository: 'someone/disky' } }),
      record(7, { payload: { verified_sha: OLD } }),
      record(8),
    ]
    expect([
      previewRecord(list, 'Open-Athena/disky', 9, HOST),
      previewRecord([record(9, { payload: { verified_sha: 'short' } })], 'open-athena/disky', 9, HOST),
      previewRecord(list.slice(0, 6), 'Open-Athena/disky', 9, HOST),
      previewRecord({ message: 'x' }, 'Open-Athena/disky', 9, HOST),
    ]).toEqual([{ id: 7, sha: OLD, at: '2026-11-19T02:04:03Z' }, { id: 9, sha: '', at: '2026-11-19T02:04:03Z' }, null, null])
  })
})

describe('githubPreviewPrs', () => {
  /** A fake GitHub: PR 9 (`pr`), the head's deployments, the repo's, and each record's latest status. */
  function setup(o: { token?: string; pr?: Record<string, unknown> | number | Error; atHead?: unknown[]; all?: unknown[] | number; status?: string } = {}) {
    let clock = 0
    const calls: [string, Record<string, string>][] = []
    const answers: (Record<string, unknown> | number | Error)[] = []
    const prBody = { number: 9, title: 't', state: 'open', updated_at: 'x', user: { login: 'u' }, head: { ref: 'h', sha: HEAD, repo: null }, base: { ref: 'b' } }
    const fetch = (async (url: string, init?: RequestInit) => {
      calls.push([url, Object.fromEntries(new Headers(init?.headers))])
      const path = url.replace('https://api.github.com/repos/Open-Athena/disky/', '')
      const answer = path === 'pulls/9' ? (answers.shift() ?? o.pr ?? prBody)
        : path === `deployments?sha=${HEAD}&per_page=100` ? (o.atHead ?? [])
        : path === 'deployments?per_page=100' ? (o.all ?? [])
        : /^deployments\/\d+\/statuses\?per_page=1$/.test(path) ? [{ state: o.status ?? 'success' }]
        : 599
      if (answer instanceof Error) throw answer
      return typeof answer === 'number' ? new Response('{}', { status: answer }) : Response.json(answer)
    }) as typeof globalThis.fetch
    const prs = githubPreviewPrs({ fetch, now: () => clock, ...(o.token ? { token: o.token } : {}) })
    const paths = () => calls.map(([u]) => u.replace('https://api.github.com/repos/Open-Athena/disky/', ''))
    return { prs, answers, calls, paths, at: (s: number) => { clock = s * 1000 } }
  }
  const deployment = async (t: ReturnType<typeof setup>) => {
    const r = await t.prs(SOURCE, 9, HOST)
    return r.status === 'found' ? r.deployment : r.status
  }

  it('asks GitHub with its own token, and reuses an answer for 60 s', async () => {
    const t = setup({ token: 'test-token' })
    const first = await t.prs(SOURCE, 9, HOST)
    t.at(59)
    await t.prs(SOURCE, 9, HOST)
    t.at(60)
    await t.prs(SOURCE, 9, HOST)
    expect([first.status, t.calls.filter(([u]) => u.endsWith('/pulls/9')), t.calls.length]).toEqual([
      'found',
      [0, 1].map(() => ['https://api.github.com/repos/Open-Athena/disky/pulls/9', {
        accept: 'application/vnd.github+json',
        authorization: 'Bearer test-token',
        'user-agent': 'oa-auth-broker',
        'x-github-api-version': '2022-11-28',
      }]),
      6,
    ])
  })

  it("caches a missing PR, but not a failure, and doesn't serve a stale answer when GitHub fails", async () => {
    const t = setup()
    t.answers.push(404, 500, new Error('network'), 403)
    const results = [await t.prs(SOURCE, 9, HOST), await t.prs(SOURCE, 9, HOST)]
    t.at(60)
    results.push(await t.prs(SOURCE, 9, HOST), await t.prs(SOURCE, 9, HOST), await t.prs(SOURCE, 9, HOST), await t.prs(SOURCE, 9, HOST))
    expect([results.map(r => r.status), t.paths().filter(p => p === 'pulls/9').length, t.calls[0]![1].authorization]).toEqual([
      ['missing', 'missing', 'unavailable', 'unavailable', 'unavailable', 'found'],
      5,
      undefined,
    ])
  })

  it("confirms the host serves the PR from its workflow's record: the head's own first, else the repo's newest; and says when it's behind", async () => {
    const atHead = setup({ atHead: [record(7)] })
    const behind = setup({ all: [record(5, { payload: { sha: OLD, verified_sha: OLD } })] })
    expect([await deployment(atHead), atHead.paths(), await deployment(behind), behind.paths()]).toEqual([
      { status: 'live', sha: HEAD, at: '2026-11-19T02:04:03Z' },
      ['pulls/9', `deployments?sha=${HEAD}&per_page=100`, 'deployments/7/statuses?per_page=1'],
      { status: 'live', sha: OLD, at: '2026-11-19T02:04:03Z' },
      ['pulls/9', `deployments?sha=${HEAD}&per_page=100`, 'deployments?per_page=100', 'deployments/5/statuses?per_page=1'],
    ])
  })

  it("doesn't confirm a retired record, no record, or one with no verified commit; and doesn't keep a deployment check that failed", async () => {
    const failing = setup({ all: 500 })
    const failed = [await deployment(failing), await deployment(failing)]
    expect([
      await deployment(setup({ atHead: [record(7)], status: 'inactive' })),
      await deployment(setup()),
      await deployment(setup({ atHead: [record(7, { payload: { verified_sha: undefined } })] })),
      failed,
      failing.paths().filter(p => p === 'pulls/9').length,
      // A closed PR's deployments aren't asked about: it's refused anyway.
      await deployment(setup({ pr: { number: 9, title: 't', state: 'closed', updated_at: 'x', user: { login: 'u' }, head: { ref: 'h', sha: HEAD, repo: null }, base: { ref: 'b' } } })),
    ]).toEqual([
      { status: 'unconfirmed' },
      { status: 'unconfirmed' },
      { status: 'unconfirmed' },
      [{ status: 'unavailable' }, { status: 'unavailable' }],
      2,
      { status: 'unconfirmed' },
    ])
  })
})
