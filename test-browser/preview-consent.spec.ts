// The PR-preview consent page in a real browser: the Origin its own form POST
// carries is the browser's to decide (from the page's referrer policy), which
// is what the 2026-11-12 `no-referrer` bug got wrong and in-process tests missed.
import { expect, test } from '@playwright/test'
import { createGate } from '../dist/index.js'
import { generateSigningKey, hashClientSecret, memoryProviderStore, oidcProviderRoutes } from '../dist/provider/index.js'
import { memoryGrantStore } from '../dist/testing/index.js'

const ISSUER = 'https://login.test'
const BRANCH = 'pr-1.proj.pages.dev'

async function broker() {
  const gate = createGate({
    store: memoryGrantStore(),
    secret: 'preview-consent-browser-secret',
    policy: async (e: string) => (e.endsWith('@openathena.ai') ? ['member'] : null),
  })
  const provider = oidcProviderRoutes({
    gate,
    issuer: ISSUER,
    clients: [{
      id: 'app-p',
      name: 'Project',
      secretHash: await hashClientSecret('app-p-secret'),
      redirectUris: ['https://*.proj.pages.dev/auth/cb'],
      preview: true,
    }],
    keys: [await generateSigningKey('k1')],
    store: memoryProviderStore(),
    subjectSecret: 'subject-secret',
    loginUrl: '/signin',
  })
  const signedIn = (await gate.signIn('ada@openathena.ai', new Request(ISSUER)))!
  return { provider, cookie: signedIn.cookie.split(';')[0]! }
}

test('one click on "Sign in to a preview?" posts with the real Origin and is sent back to the branch with a code', async ({ page, context }, info) => {
  const { provider, cookie } = await broker()
  const [name, ...value] = cookie.split('=')
  await context.addCookies([{ name: name!, value: value.join('='), url: `${ISSUER}/`, secure: true, httpOnly: true, sameSite: 'Lax' }])
  // The consent form's POST as the browser sent it, and what the provider answered.
  const posted: { origin: string | null; status: number; location: string | null }[] = []
  await context.route(`${ISSUER}/**`, async route => {
    const r = route.request()
    const headers = await r.allHeaders()
    const res = await provider(new Request(r.url(), { method: r.method(), headers, ...(r.method() === 'POST' ? { body: r.postData() ?? '' } : {}) }))
    if (!res) return route.fulfill({ status: 404, body: 'no route' })
    if (r.method() === 'POST') {
      posted.push({ origin: headers.origin ?? null, status: res.status, location: res.headers.get('location') })
      // A redirect out of a fulfilled response isn't routed, so it would reach the real branch host: stop here.
      return route.fulfill({ contentType: 'text/html', body: `<!doctype html><title>answered</title><h1>Answered ${res.status}</h1>` })
    }
    await route.fulfill({ status: res.status, headers: Object.fromEntries(res.headers), body: Buffer.from(await res.arrayBuffer()) })
  })

  const authorize = new URL(`${ISSUER}/oidc/authorize`)
  for (const [k, v] of Object.entries({
    client_id: 'app-p', redirect_uri: `https://${BRANCH}/auth/cb`, response_type: 'code', scope: 'openid email', state: 's1',
    code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM', code_challenge_method: 'S256',
  })) authorize.searchParams.set(k, v)
  await page.goto(authorize.toString())
  await expect(page.getByText(`${BRANCH} wants to sign you in as ada@openathena.ai.`)).toBeVisible()
  await page.screenshot({ path: `tmp/preview-consent-${info.project.name}.png`, fullPage: true })
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(page.getByRole('heading', { name: 'Answered 302' })).toBeVisible()
  const [{ origin, status, location }] = posted as [(typeof posted)[number]]
  const back = new URL(location!)
  expect([posted.length, origin, status, back.host, back.pathname, back.searchParams.get('state'), /^[\w-]{20,}$/.test(back.searchParams.get('code') ?? '')]).toEqual([
    1, ISSUER, 302, BRANCH, '/auth/cb', 's1', true,
  ])
})
