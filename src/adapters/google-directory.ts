/**
 * Google Workspace groups → the allowlist table.
 *
 * Google's OIDC id_token never carries group membership, and nothing pushes a
 * group change to a custom app (Google's Shared Signals role is *receiver*,
 * session-revocation only). So "gate this app to board@" is a periodic pull:
 * a service account lists the group, `replaceSource` swaps the rows, and
 * `allowlistPolicy` — re-evaluated on every request — denies a removed member
 * on their next request. Revocation lag is the sync interval, which at 5–15
 * minutes beats the ~1 h token lifetime most orgs accept.
 *
 * The runtime half lives here because it is small and easy to get subtly
 * wrong once per app: mint a service-account token (WebCrypto RS256 JWT-bearer,
 * no library), page through one of two group APIs, filter to active users.
 * The provisioning half (create the SA, grant it read access) stays `gcloud`
 * / IaC — see specs/done/google-directory-sync.md for the recipe and the
 * three auth models. The package holds no credential: the key is passed in.
 *
 * Runs on bare Workers: `fetch` + `crypto.subtle`, no `nodejs_compat`.
 */
import { b64uEncode } from '../core/base64.js'
import type { AllowEntry, AllowlistStore } from '../core/store.js'

const enc = new TextEncoder()

export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
export const DIRECTORY_API = 'https://admin.googleapis.com/admin/directory/v1'
export const CLOUD_IDENTITY_API = 'https://cloudidentity.googleapis.com/v1'
/** Read-only scope for the Admin SDK Directory `members.list` path. */
export const DIRECTORY_SCOPE = 'https://www.googleapis.com/auth/admin.directory.group.member.readonly'
/** Read-only scope for the Cloud Identity `memberships.list` path. */
export const CLOUD_IDENTITY_SCOPE = 'https://www.googleapis.com/auth/cloud-identity.groups.readonly'

/** The fields of a downloaded service-account key JSON this adapter reads. */
export interface ServiceAccountKey {
  client_email: string
  private_key: string
  /** Defaults to `GOOGLE_TOKEN_URL`; the key file carries it too. */
  token_uri?: string
}

export interface AccessTokenOptions {
  /** The key JSON, parsed or as the raw string a secret store hands back. */
  key: ServiceAccountKey | string
  scopes: readonly string[]
  /**
   * Domain-wide delegation only: the admin to impersonate (the JWT `sub`).
   * Omit for a role-assigned or group-owner service account, which acts as
   * itself.
   */
  subject?: string
  fetch?: typeof globalThis.fetch
  nowMs?: number
}

export interface AccessToken {
  accessToken: string
  /** Epoch seconds. */
  expiresAt: number
  /** The service account's `client_email` — handy for logs and `addedBy`. */
  clientEmail: string
}

/** Which Google API lists the group. Both accept a role-assigned or owner SA. */
export type GroupsApi = 'directory' | 'cloud-identity'

export interface ListMembersOptions {
  token: string
  /**
   * `directory` (default) flattens nested groups (`includeDerivedMembership`)
   * on every Workspace edition. `cloud-identity` lists direct members only —
   * its transitive search is Enterprise/Premium-gated.
   */
  api?: GroupsApi
  fetch?: typeof globalThis.fetch
}

function parseKey(key: ServiceAccountKey | string): ServiceAccountKey {
  let parsed: unknown = key
  if (typeof key === 'string') {
    try {
      parsed = JSON.parse(key)
    } catch {
      throw new Error('service account key: not JSON')
    }
  }
  const k = parsed as Partial<ServiceAccountKey> | null
  if (!k || typeof k.client_email !== 'string' || typeof k.private_key !== 'string') {
    throw new Error('service account key: missing client_email or private_key')
  }
  return k as ServiceAccountKey
}

/** PKCS#8 PEM → CryptoKey. The key file's `private_key` is always PKCS#8. */
async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const body = pem.replace(/-----(BEGIN|END) PRIVATE KEY-----|\s/g, '')
  const bin = atob(body)
  const der = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) der[i] = bin.charCodeAt(i)
  return crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign'])
}

/**
 * Mint an access token for a service account: sign a JWT-bearer assertion
 * with the key and trade it at the token endpoint. Throws on any failure —
 * every one is a provisioning error (bad key, wrong scope, no role), not a
 * state to handle at runtime.
 */
export async function googleAccessToken({
  key,
  scopes,
  subject,
  fetch = globalThis.fetch,
  nowMs = Date.now(),
}: AccessTokenOptions): Promise<AccessToken> {
  const sa = parseKey(key)
  const tokenUrl = sa.token_uri ?? GOOGLE_TOKEN_URL
  const iat = Math.floor(nowMs / 1000)
  const claims = {
    iss: sa.client_email,
    scope: scopes.join(' '),
    aud: tokenUrl,
    iat,
    exp: iat + 3600,
    ...(subject ? { sub: subject } : {}),
  }
  const header = b64uEncode(enc.encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })))
  const payload = b64uEncode(enc.encode(JSON.stringify(claims)))
  const signingKey = await importPrivateKey(sa.private_key)
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', signingKey, enc.encode(`${header}.${payload}`))
  const assertion = `${header}.${payload}.${b64uEncode(sig)}`

  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(),
  })
  if (!res.ok) throw new Error(`google token endpoint: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`)
  const body = (await res.json()) as { access_token?: unknown; expires_in?: unknown }
  if (typeof body.access_token !== 'string') throw new Error('google token endpoint: no access_token in response')
  const expiresIn = typeof body.expires_in === 'number' ? body.expires_in : 3600
  return { accessToken: body.access_token, expiresAt: iat + expiresIn, clientEmail: sa.client_email }
}

async function getJson<T>(fetch: typeof globalThis.fetch, url: string, token: string): Promise<T> {
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } })
  if (!res.ok) throw new Error(`${new URL(url).pathname}: HTTP ${res.status}`)
  return res.json() as Promise<T>
}

interface DirectoryMember {
  email?: string
  type?: string
  status?: string
}

async function directoryMembers(fetch: typeof globalThis.fetch, token: string, group: string): Promise<string[]> {
  const out: string[] = []
  let pageToken: string | undefined
  do {
    const url = new URL(`${DIRECTORY_API}/groups/${encodeURIComponent(group)}/members`)
    url.searchParams.set('includeDerivedMembership', 'true')
    url.searchParams.set('maxResults', '200')
    if (pageToken) url.searchParams.set('pageToken', pageToken)
    const page = await getJson<{ members?: DirectoryMember[]; nextPageToken?: string }>(fetch, url.href, token)
    // Nested groups are already flattened into their USER members by
    // `includeDerivedMembership`, so the GROUP rows themselves carry nothing.
    // A suspended user can't sign in to Google anyway; keep the table honest.
    for (const m of page.members ?? []) {
      if (m.type === 'USER' && m.status !== 'SUSPENDED' && typeof m.email === 'string') out.push(m.email)
    }
    pageToken = page.nextPageToken
  } while (pageToken)
  return out
}

interface CloudIdentityMembership {
  preferredMemberKey?: { id?: string }
  type?: string
}

async function cloudIdentityMembers(fetch: typeof globalThis.fetch, token: string, group: string): Promise<string[]> {
  const lookup = await getJson<{ name?: string }>(
    fetch,
    `${CLOUD_IDENTITY_API}/groups:lookup?groupKey.id=${encodeURIComponent(group)}`,
    token,
  )
  if (typeof lookup.name !== 'string') throw new Error(`cloud identity: no group ${group}`)
  const out: string[] = []
  let pageToken: string | undefined
  do {
    const url = new URL(`${CLOUD_IDENTITY_API}/${lookup.name}/memberships`)
    url.searchParams.set('pageSize', '500')
    if (pageToken) url.searchParams.set('pageToken', pageToken)
    const page = await getJson<{ memberships?: CloudIdentityMembership[]; nextPageToken?: string }>(fetch, url.href, token)
    for (const m of page.memberships ?? []) {
      if (m.type === 'USER' && typeof m.preferredMemberKey?.id === 'string') out.push(m.preferredMemberKey.id)
    }
    pageToken = page.nextPageToken
  } while (pageToken)
  return out
}

/**
 * The group's active user members: lowercased, de-duplicated, sorted. Throws
 * on a non-2xx from Google (a permissions or provisioning problem).
 */
export async function listGroupMembers(
  group: string,
  { token, api = 'directory', fetch = globalThis.fetch }: ListMembersOptions,
): Promise<string[]> {
  const raw = api === 'directory' ? await directoryMembers(fetch, token, group) : await cloudIdentityMembers(fetch, token, group)
  return [...new Set(raw.map(e => e.toLowerCase()))].sort()
}

export interface GroupSpec {
  /** The group's email address. */
  group: string
  /** Scopes every member earns. */
  scopes: readonly string[]
}

export interface SyncOptions extends Omit<AccessTokenOptions, 'scopes'> {
  groups: readonly GroupSpec[]
  api?: GroupsApi
}

export interface SyncResult {
  group: string
  /** The `AllowEntry.source` the group's rows carry. */
  source: string
  count: number
}

/** The allowlist `source` a synced group owns: `sync:<group>`. */
export const syncSource = (group: string): string => `sync:${group.toLowerCase()}`

/**
 * One token, then per group: list → `replaceSource`. Rows carry the group's
 * scopes and `addedBy: <service account email>`. A listing that throws stops
 * before that group's `replaceSource`, so a transient Google error never
 * empties a group — the previous membership stands until the next run.
 *
 * Call this from a Worker `scheduled()` handler (or any cron) with the same
 * `AllowlistStore` the app's `allowlistPolicy` reads.
 */
export async function syncGroupsToAllowlist(
  store: Pick<AllowlistStore, 'replaceSource'>,
  { groups, api = 'directory', key, subject, fetch = globalThis.fetch, nowMs = Date.now() }: SyncOptions,
): Promise<SyncResult[]> {
  const scope = api === 'directory' ? DIRECTORY_SCOPE : CLOUD_IDENTITY_SCOPE
  const { accessToken, clientEmail } = await googleAccessToken({ key, scopes: [scope], subject, fetch, nowMs })
  const updatedAt = Math.floor(nowMs / 1000)
  const results: SyncResult[] = []
  for (const { group, scopes } of groups) {
    const emails = await listGroupMembers(group, { token: accessToken, api, fetch })
    const source = syncSource(group)
    const entries: AllowEntry[] = emails.map(email => ({
      email,
      scopes: [...scopes],
      source,
      note: null,
      addedBy: clientEmail,
      updatedAt,
    }))
    await store.replaceSource(source, entries)
    results.push({ group, source, count: entries.length })
  }
  return results
}
