import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { UsageError, main, parseArgs, secretPutArgs } from '../scripts/verify-group-sync.mjs'

const KEY = '{"client_email":"sa@p.iam.gserviceaccount.com","private_key":"x"}'

/** A scripted adapter: records what it was asked, answers from `members`. */
function fakeAdapter(members, { tokenError = null } = {}) {
  const calls = []
  return {
    calls,
    adapter: {
      DIRECTORY_SCOPE: 'dir-scope',
      CLOUD_IDENTITY_SCOPE: 'ci-scope',
      googleAccessToken: async ({ key, scopes, subject }) => {
        calls.push({ fn: 'token', key, scopes, subject })
        if (tokenError) throw new Error(tokenError)
        return { accessToken: 'tok', expiresAt: 1, clientEmail: 'sa@p.iam.gserviceaccount.com' }
      },
      listGroupMembers: async (group, { token, api }) => {
        calls.push({ fn: 'list', group, token, api })
        const m = members[group]
        if (!m) throw new Error(`/groups/${group}/members: HTTP 403`)
        return m
      },
    },
  }
}

async function run(argv, adapter, stdinText = KEY) {
  const lines = []
  const execs = []
  const code = await main(argv, {
    stdin: Readable.from([stdinText]),
    exec: (cmd, args, input) => execs.push({ cmd, args, input }),
    err: l => lines.push(l),
    adapter,
  })
  return { code, lines, execs }
}

describe('parseArgs', () => {
  it('collects groups (lowercased), api, subject, and one store target', () => {
    expect(parseArgs(['--group', 'Board@X.test', '--group', 'team@x.test', '--api', 'cloud-identity', '--subject', 'a@x.test', '--store-pages', 'app'])).toEqual({
      groups: ['board@x.test', 'team@x.test'],
      api: 'cloud-identity',
      subject: 'a@x.test',
      pagesProject: 'app',
      worker: null,
      help: false,
    })
  })

  it('rejects no group, a bad api, and both store targets', () => {
    expect(() => parseArgs([])).toThrow(new UsageError('at least one --group is required'))
    expect(() => parseArgs(['--group', 'g@x.test', '--api', 'ldap'])).toThrow(new UsageError('--api must be one of directory, cloud-identity, got "ldap"'))
    expect(() => parseArgs(['--group', 'g@x.test', '--store-pages', 'a', '--store-worker', 'b'])).toThrow(
      new UsageError('--store-pages and --store-worker are mutually exclusive'),
    )
  })
})

describe('secretPutArgs', () => {
  it('targets a Pages project or a Worker', () => {
    expect(secretPutArgs({ pagesProject: 'app', worker: null })).toEqual(['pages', 'secret', 'put', 'GOOGLE_SA_KEY', '--project-name', 'app'])
    expect(secretPutArgs({ pagesProject: null, worker: 'w' })).toEqual(['secret', 'put', 'GOOGLE_SA_KEY', '--name', 'w'])
  })
})

describe('main', () => {
  it('mints one token with the api scope, lists each group, prints members, stores nothing without a target', async () => {
    const { calls, adapter } = fakeAdapter({ 'board@x.test': ['al@x.test', 'bo@x.test'], 'team@x.test': ['al@x.test'] })
    const { code, lines, execs } = await run(['--group', 'board@x.test', '--group', 'team@x.test'], adapter)
    expect(code).toBe(0)
    expect(calls).toEqual([
      { fn: 'token', key: KEY, scopes: ['dir-scope'], subject: undefined },
      { fn: 'list', group: 'board@x.test', token: 'tok', api: 'directory' },
      { fn: 'list', group: 'team@x.test', token: 'tok', api: 'directory' },
    ])
    expect(lines).toEqual([
      'token: ok (sa@p.iam.gserviceaccount.com)',
      'board@x.test: 2 members',
      '  al@x.test',
      '  bo@x.test',
      'team@x.test: 1 member',
      '  al@x.test',
    ])
    expect(execs).toEqual([])
  })

  it('stores the key via wrangler on stdin only after every listing succeeded', async () => {
    const { adapter } = fakeAdapter({ 'board@x.test': ['al@x.test'] })
    const { lines, execs } = await run(['--group', 'board@x.test', '--store-pages', 'funds'], adapter)
    expect(lines.at(-1)).toBe('storing: npx wrangler pages secret put GOOGLE_SA_KEY --project-name funds  # key on stdin (hidden)')
    expect(execs).toEqual([{ cmd: 'npx', args: ['wrangler', 'pages', 'secret', 'put', 'GOOGLE_SA_KEY', '--project-name', 'funds'], input: KEY }])
    expect(lines.filter(l => l.includes('private_key'))).toEqual([])
  })

  it('a failed listing propagates and stores nothing', async () => {
    const { adapter } = fakeAdapter({})
    const lines = []
    const execs = []
    await expect(
      main(['--group', 'board@x.test', '--store-pages', 'funds'], {
        stdin: Readable.from([KEY]),
        exec: (cmd, args, input) => execs.push({ cmd, args, input }),
        err: l => lines.push(l),
        adapter,
      }),
    ).rejects.toThrow('/groups/board@x.test/members: HTTP 403')
    expect(execs).toEqual([])
  })

  it('passes --subject and the cloud-identity scope through', async () => {
    const { calls, adapter } = fakeAdapter({ 'g@x.test': [] })
    await run(['--group', 'g@x.test', '--api', 'cloud-identity', '--subject', 'admin@x.test'], adapter)
    expect(calls[0]).toEqual({ fn: 'token', key: KEY, scopes: ['ci-scope'], subject: 'admin@x.test' })
    expect(calls[1]).toEqual({ fn: 'list', group: 'g@x.test', token: 'tok', api: 'cloud-identity' })
  })

  it('rejects empty stdin before touching Google', async () => {
    const { calls, adapter } = fakeAdapter({})
    await expect(run(['--group', 'g@x.test'], adapter, '  ')).rejects.toThrow(new UsageError('expected the service-account key JSON on stdin'))
    expect(calls).toEqual([])
  })
})
