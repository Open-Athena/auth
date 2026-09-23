import { beforeAll, describe, expect, it } from 'vitest'
import { d1Allowlist } from '../src/adapters/d1.js'
import {
  CLOUD_IDENTITY_SCOPE,
  DIRECTORY_SCOPE,
  GOOGLE_TOKEN_URL,
  type ServiceAccountKey,
  googleAccessToken,
  listGroupMembers,
  syncGroupsToAllowlist,
} from '../src/adapters/google-directory.js'
import { b64uDecodeBytes, b64uDecodeString } from '../src/core/base64.js'
import { allowlistPolicy } from '../src/core/policy.js'
import type { AllowEntry } from '../src/core/store.js'
import { testDb } from './d1-shim.js'

const SA_EMAIL = 'group-sync@proj.iam.gserviceaccount.com'
const NOW_MS = 1_700_000_000_000
const IAT = 1_700_000_000
const DIRECTORY = 'https://admin.googleapis.com/admin/directory/v1'
const CLOUD_IDENTITY = 'https://cloudidentity.googleapis.com/v1'

let keys: CryptoKeyPair
let saKey: ServiceAccountKey

beforeAll(async () => {
  keys = (await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair
  const der = new Uint8Array((await crypto.subtle.exportKey('pkcs8', keys.privateKey)) as ArrayBuffer)
  let bin = ''
  for (const b of der) bin += String.fromCharCode(b)
  const lines = btoa(bin).match(/.{1,64}/g) ?? []
  saKey = {
    client_email: SA_EMAIL,
    private_key: `-----BEGIN PRIVATE KEY-----\n${lines.join('\n')}\n-----END PRIVATE KEY-----\n`,
    token_uri: GOOGLE_TOKEN_URL,
  }
})

type Page = Record<string, unknown>

interface FakeGoogle {
  fetch: typeof globalThis.fetch
  /** Every URL requested, in order. */
  urls: string[]
  /** The decoded JWT-bearer assertion the token endpoint received, once it has. */
  assertion: { header: Record<string, unknown>; claims: Record<string, unknown>; verified: boolean } | null
}

/**
 * The token endpoint (verifies the assertion against the test public key)
 * plus canned, paged responses keyed by URL. Anything else 404s.
 */
function fakeGoogle(pages: Record<string, Page | { status: number }>, tokenStatus = 200): FakeGoogle {
  const state: FakeGoogle = { urls: [], assertion: null, fetch: null as unknown as typeof globalThis.fetch }
  state.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    state.urls.push(url)
    if (url === GOOGLE_TOKEN_URL) {
      const form = new URLSearchParams(String(init?.body))
      expect(form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer')
      const [h, p, s] = form.get('assertion')!.split('.') as [string, string, string]
      const verified = await crypto.subtle.verify(
        'RSASSA-PKCS1-v1_5',
        keys.publicKey,
        b64uDecodeBytes(s),
        new TextEncoder().encode(`${h}.${p}`),
      )
      state.assertion = { header: JSON.parse(b64uDecodeString(h)), claims: JSON.parse(b64uDecodeString(p)), verified }
      if (tokenStatus !== 200) return Response.json({ error: 'unauthorized_client' }, { status: tokenStatus })
      return Response.json({ access_token: 'tok-1', expires_in: 3599, token_type: 'Bearer' })
    }
    const page = pages[url]
    if (!page) return new Response(null, { status: 404 })
    expect(init?.headers).toEqual({ authorization: 'Bearer tok-1' })
    if ('status' in page && typeof page.status === 'number' && Object.keys(page).length === 1) {
      return new Response('denied', { status: page.status })
    }
    return Response.json(page)
  }) as typeof globalThis.fetch
  return state
}

const membersUrl = (group: string, pageToken?: string) =>
  `${DIRECTORY}/groups/${encodeURIComponent(group)}/members?includeDerivedMembership=true&maxResults=200${
    pageToken ? `&pageToken=${pageToken}` : ''
  }`

describe('googleAccessToken', () => {
  it('signs a JWT-bearer assertion with exactly the expected claims and returns the token', async () => {
    const g = fakeGoogle({})
    const token = await googleAccessToken({ key: saKey, scopes: [DIRECTORY_SCOPE], fetch: g.fetch, nowMs: NOW_MS })
    expect(token).toEqual({ accessToken: 'tok-1', expiresAt: IAT + 3599, clientEmail: SA_EMAIL })
    expect(g.assertion).toEqual({
      header: { alg: 'RS256', typ: 'JWT' },
      claims: { iss: SA_EMAIL, scope: DIRECTORY_SCOPE, aud: GOOGLE_TOKEN_URL, iat: IAT, exp: IAT + 3600 },
      verified: true,
    })
    expect(g.urls).toEqual([GOOGLE_TOKEN_URL])
  })

  it('adds `sub` only when a domain-wide-delegation subject is given, and accepts the key as a JSON string', async () => {
    const g = fakeGoogle({})
    await googleAccessToken({
      key: JSON.stringify(saKey),
      scopes: [DIRECTORY_SCOPE, CLOUD_IDENTITY_SCOPE],
      subject: 'admin@x.test',
      fetch: g.fetch,
      nowMs: NOW_MS,
    })
    expect(g.assertion?.claims).toEqual({
      iss: SA_EMAIL,
      scope: `${DIRECTORY_SCOPE} ${CLOUD_IDENTITY_SCOPE}`,
      aud: GOOGLE_TOKEN_URL,
      iat: IAT,
      exp: IAT + 3600,
      sub: 'admin@x.test',
    })
  })

  it('throws on a rejected assertion, carrying the status and error body', async () => {
    const g = fakeGoogle({}, 401)
    await expect(googleAccessToken({ key: saKey, scopes: [DIRECTORY_SCOPE], fetch: g.fetch })).rejects.toThrow(
      'google token endpoint: HTTP 401 {"error":"unauthorized_client"}',
    )
  })

  it('rejects a malformed key before touching the network', async () => {
    const g = fakeGoogle({})
    await expect(googleAccessToken({ key: 'not json', scopes: [], fetch: g.fetch })).rejects.toThrow('service account key: not JSON')
    await expect(googleAccessToken({ key: '{"client_email":"a@b"}', scopes: [], fetch: g.fetch })).rejects.toThrow(
      'service account key: missing client_email or private_key',
    )
    expect(g.urls).toEqual([])
  })
})

describe('listGroupMembers', () => {
  it('directory: follows pages, keeps active users only, lowercases, de-dups and sorts', async () => {
    const g = fakeGoogle({
      [membersUrl('board@x.test')]: {
        members: [
          { email: 'Zed@x.test', type: 'USER', status: 'ACTIVE' },
          { email: 'nested@x.test', type: 'GROUP', status: 'ACTIVE' },
          { email: 'gone@x.test', type: 'USER', status: 'SUSPENDED' },
        ],
        nextPageToken: 'p2',
      },
      [membersUrl('board@x.test', 'p2')]: {
        members: [
          { email: 'amy@x.test', type: 'USER', status: 'ACTIVE' },
          { email: 'zed@x.test', type: 'USER', status: 'ACTIVE' },
        ],
      },
    })
    expect(await listGroupMembers('board@x.test', { token: 'tok-1', fetch: g.fetch })).toEqual(['amy@x.test', 'zed@x.test'])
    expect(g.urls).toEqual([membersUrl('board@x.test'), membersUrl('board@x.test', 'p2')])
  })

  it('cloud-identity: looks the group up, then pages its memberships', async () => {
    const g = fakeGoogle({
      [`${CLOUD_IDENTITY}/groups:lookup?groupKey.id=board%40x.test`]: { name: 'groups/abc' },
      [`${CLOUD_IDENTITY}/groups/abc/memberships?pageSize=500`]: {
        memberships: [
          { preferredMemberKey: { id: 'Bo@x.test' }, type: 'USER' },
          { preferredMemberKey: { id: 'sub@x.test' }, type: 'GROUP' },
        ],
        nextPageToken: 'n',
      },
      [`${CLOUD_IDENTITY}/groups/abc/memberships?pageSize=500&pageToken=n`]: {
        memberships: [{ preferredMemberKey: { id: 'al@x.test' }, type: 'USER' }],
      },
    })
    expect(await listGroupMembers('board@x.test', { token: 'tok-1', api: 'cloud-identity', fetch: g.fetch })).toEqual([
      'al@x.test',
      'bo@x.test',
    ])
    expect(g.urls).toEqual([
      `${CLOUD_IDENTITY}/groups:lookup?groupKey.id=board%40x.test`,
      `${CLOUD_IDENTITY}/groups/abc/memberships?pageSize=500`,
      `${CLOUD_IDENTITY}/groups/abc/memberships?pageSize=500&pageToken=n`,
    ])
  })

  it('throws on a non-2xx, naming the path', async () => {
    const g = fakeGoogle({ [membersUrl('board@x.test')]: { status: 403 } })
    await expect(listGroupMembers('board@x.test', { token: 'tok-1', fetch: g.fetch })).rejects.toThrow(
      '/admin/directory/v1/groups/board%40x.test/members: HTTP 403',
    )
  })
})

describe('syncGroupsToAllowlist', () => {
  const manual: AllowEntry = { email: 'guest@y.test', scopes: ['view'], source: 'manual', note: null, addedBy: 'boss@x.test', updatedAt: 5 }
  const row = (email: string, scopes: string[], group: string): AllowEntry => ({
    email,
    scopes,
    source: `sync:${group}`,
    note: null,
    addedBy: SA_EMAIL,
    updatedAt: IAT,
  })
  const directory = (group: string, emails: string[]) => ({
    [membersUrl(group)]: { members: emails.map(email => ({ email, type: 'USER', status: 'ACTIVE' })) },
  })

  it('writes each group into its own source with the configured scopes, leaving manual rows alone', async () => {
    const store = d1Allowlist(testDb())
    await store.put(manual)
    const g = fakeGoogle({ ...directory('board@x.test', ['bo@x.test', 'al@x.test']), ...directory('staff@x.test', ['al@x.test']) })
    const results = await syncGroupsToAllowlist(store, {
      key: saKey,
      groups: [
        { group: 'board@x.test', scopes: ['board'] },
        { group: 'staff@x.test', scopes: ['staff', 'view'] },
      ],
      fetch: g.fetch,
      nowMs: NOW_MS,
    })
    expect(results).toEqual([
      { group: 'board@x.test', source: 'sync:board@x.test', count: 2 },
      { group: 'staff@x.test', source: 'sync:staff@x.test', count: 1 },
    ])
    expect(g.urls).toEqual([GOOGLE_TOKEN_URL, membersUrl('board@x.test'), membersUrl('staff@x.test')])
    expect(g.assertion?.claims.scope).toBe(DIRECTORY_SCOPE)
    // One row per email: `al@` lands in whichever group synced last — that's
    // the store's upsert-by-email, not something the sync papers over.
    expect(await store.list()).toEqual([
      row('al@x.test', ['staff', 'view'], 'staff@x.test'),
      row('bo@x.test', ['board'], 'board@x.test'),
      manual,
    ])
  })

  it('a removed member is denied by allowlistPolicy after the next sync', async () => {
    const store = d1Allowlist(testDb())
    const policy = allowlistPolicy(store)
    const opts = { key: saKey, groups: [{ group: 'board@x.test', scopes: ['board'] }], nowMs: NOW_MS }
    await syncGroupsToAllowlist(store, { ...opts, fetch: fakeGoogle(directory('board@x.test', ['bo@x.test', 'al@x.test'])).fetch })
    expect(await policy('bo@x.test')).toEqual(['board'])
    await syncGroupsToAllowlist(store, { ...opts, fetch: fakeGoogle(directory('board@x.test', ['al@x.test'])).fetch })
    expect(await policy('bo@x.test')).toBeNull()
    expect(await policy('al@x.test')).toEqual(['board'])
  })

  it('leaves the table untouched when Google errors mid-run', async () => {
    const store = d1Allowlist(testDb())
    const opts = { key: saKey, groups: [{ group: 'board@x.test', scopes: ['board'] }], nowMs: NOW_MS }
    await syncGroupsToAllowlist(store, { ...opts, fetch: fakeGoogle(directory('board@x.test', ['bo@x.test'])).fetch })
    await expect(
      syncGroupsToAllowlist(store, { ...opts, fetch: fakeGoogle({ [membersUrl('board@x.test')]: { status: 500 } }).fetch }),
    ).rejects.toThrow('/admin/directory/v1/groups/board%40x.test/members: HTTP 500')
    expect(await store.list()).toEqual([row('bo@x.test', ['board'], 'board@x.test')])
  })
})
