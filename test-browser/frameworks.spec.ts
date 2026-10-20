import { expect, test } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import type { Whoami } from '../src/client/identity.js'

const examples = [
  { path: '/', entry: 'vanilla' },
  { path: '/vanilla', entry: 'vanilla' },
  { path: '/vue', entry: 'vue' },
  { path: '/react', entry: 'react' },
] as const

async function runtimeModules(scripts: string[]) {
  const modules = await Promise.all([...new Set(scripts)].sort().map(async chunk => {
    // Inspect every fetched chunk, including generically named shared chunks.
    // Missing maps must fail rather than silently weakening the isolation check.
    const map = JSON.parse(await readFile(new URL(`../demo/dist${chunk}.map`, import.meta.url), 'utf8')) as { sources: string[] }
    return map.sources.flatMap(source => {
      const normalized = source.replaceAll('\\', '/')
      const runtime = /\/node_modules\/(react|react-dom|scheduler)(?:\/|$)/.test(normalized)
        ? 'react'
        : /\/node_modules\/(?:vue\/|@vue\/)/.test(normalized) ? 'vue' : null
      return runtime ? [{ chunk, source, runtime }] : []
    })
  }))
  return modules.flat()
}

for (const example of examples) {
  test.describe(example.path, () => {
    test('shows loading until the identity probe completes', async ({ page }) => {
      let release!: () => void
      const pending = new Promise<void>(resolve => { release = resolve })
      await page.route('**/api/view/whoami', async route => {
        await pending
        await route.fulfill({ status: 401, json: { error: 'unauthenticated' } })
      })
      try {
        await page.goto(example.path)
        await expect(page.getByText('Checking access\u2026', { exact: true })).toBeVisible()
        await expect(page.getByRole('heading', { name: 'Private workspace', exact: true })).toHaveCount(0)
      } finally {
        release()
      }
      await expect(page.getByRole('heading', { name: 'Private workspace', exact: true })).toBeVisible()
    })

    test('failed sign-out displays an alert without losing the identity', async ({ page }) => {
      await page.route('**/api/view/whoami', route => route.fulfill({ json: {
        kind: 'grant', id: 'browser-grant', name: null, subject: { name: 'Mona Octocat' },
        email: null, scopes: ['view'], admin: false, expiresAt: null,
      } }))
      await page.route('**/api/view/logout', route => route.fulfill({ status: 503, json: { error: 'unavailable' } }))
      await page.goto(example.path)
      await page.getByRole('button', { name: 'Sign out', exact: true }).click()
      await expect(page.getByRole('alert')).toHaveText('Could not sign out. Please try again.')
      await expect(page.getByText('Mona Octocat', { exact: true })).toBeVisible()
    })

    for (const named of [true, false]) {
      test(`${named ? 'named' : 'anonymous'} link exchanges, strips its key, and signs out`, async ({ page }, testInfo) => {
        let identity: Whoami | null = null
        const mutations: { path: string; method: string; body: unknown }[] = []
        const scripts: string[] = []
        page.on('request', request => {
          if (request.resourceType() === 'script') scripts.push(new URL(request.url()).pathname)
        })
        await page.route('**/api/view/whoami', route => route.fulfill(identity
          ? { json: identity }
          : { status: 401, json: { error: 'unauthenticated' } }))
        await page.route('**/api/demo-link?**', async route => {
          const url = new URL(route.request().url())
          expect(Object.fromEntries(url.searchParams)).toEqual({ named: named ? '1' : '0', next: example.path })
          await route.fulfill({ status: 302, headers: { location: `${example.path}?key=browser-token` } })
        })
        await page.route('**/api/view/exchange', async route => {
          const request = route.request()
          mutations.push({ path: new URL(request.url()).pathname, method: request.method(), body: request.postDataJSON() })
          identity = {
            kind: 'grant', id: 'browser-grant', name: null,
            subject: named ? { name: 'Mona Octocat' } : null,
            email: null, scopes: ['view'], admin: false, expiresAt: null,
          }
          await route.fulfill({ json: { ok: true } })
        })
        await page.route('**/api/view/logout', async route => {
          const request = route.request()
          mutations.push({ path: new URL(request.url()).pathname, method: request.method(), body: request.postData() })
          identity = null
          await route.fulfill({ json: { ok: true } })
        })

        await page.goto(example.path)
        await expect(page.getByRole('heading', { level: 1 })).toHaveText('@open-athena/auth')
        await expect(page.getByRole('heading', { level: 2, name: 'Private workspace', exact: true })).toBeVisible()
        for (const [label, value] of [['Open named link', '1'], ['Open anonymous link', '0']]) {
          const link = page.getByRole('link', { name: label, exact: true })
          const href = new URL(await link.getAttribute('href') ?? '', page.url())
          expect({ path: href.pathname, query: Object.fromEntries(href.searchParams) }).toEqual({
            path: '/api/demo-link', query: { named: value, next: example.path },
          })
        }
        await page.getByRole('link', { name: named ? 'Open named link' : 'Open anonymous link', exact: true }).click()
        await expect(page.getByRole('heading', { level: 2, name: "You're in.", exact: true })).toBeVisible()
        await expect(page.getByText(named ? 'Mona Octocat' : 'Anonymous link', { exact: true })).toBeVisible()
        await expect(page).toHaveURL(new URL(example.path, testInfo.project.use.baseURL).href)
        expect(mutations).toEqual([{ path: '/api/view/exchange', method: 'POST', body: { token: 'browser-token' } }])
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
        await page.screenshot({ path: testInfo.outputPath(`${example.entry}-${named ? 'named' : 'anonymous'}.png`), fullPage: true })

        await page.getByRole('button', { name: 'Sign out', exact: true }).click()
        await expect(page.getByRole('heading', { level: 2, name: 'Private workspace', exact: true })).toBeVisible()
        expect(mutations).toEqual([
          { path: '/api/view/exchange', method: 'POST', body: { token: 'browser-token' } },
          { path: '/api/view/logout', method: 'POST', body: null },
        ])
        expect([...new Set(scripts.flatMap(path => {
          const match = path.match(/\/(react|vue|vanilla)-entry[-.]/)
          return match ? [match[1]] : []
        }))].sort()).toEqual([example.entry])
        expect(scripts.filter(path => example.entry === 'vanilla'
          ? /\/(react|vue)[-.]/i.test(path)
          : new RegExp(`/${example.entry === 'vue' ? 'react' : 'vue'}[-.]`, 'i').test(path))).toEqual([])
        const modules = await runtimeModules(scripts)
        expect(modules.filter(module => module.runtime !== example.entry)).toEqual([])
        expect([...new Set(modules.map(module => module.runtime))].sort()).toEqual(
          example.entry === 'vanilla' ? [] : [example.entry],
        )
      })
    }

    test('framework links perform document navigation', async ({ page }) => {
      await page.route('**/api/view/whoami', route => route.fulfill({ status: 401, json: { error: 'unauthenticated' } }))
      await page.goto(example.path)
      for (const [name, path] of [['Vanilla', '/vanilla'], ['Vue', '/vue'], ['React', '/react']]) {
        const link = page.getByRole('navigation', { name: 'Main navigation', exact: true }).getByRole('link', { name, exact: true })
        await expect(link).toHaveAttribute('href', path)
        const navigation = page.waitForRequest(request => request.isNavigationRequest() && new URL(request.url()).pathname === path)
        await link.click()
        await navigation
        await expect(page.getByRole('heading', { level: 1 })).toHaveText('@open-athena/auth')
      }
    })
  })
}
