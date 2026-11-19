// @vitest-environment jsdom
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { OaSignInButton } from '../../src/react/OaSignInButton.js'
import { oaSignInHtml, type OaSignInHtmlOptions } from '../../src/signin/index.js'

/**
 * The link as the browser parses it, so React's and the string's spellings (`<!-- -->`, attribute case) compare; React
 * also hoists a `<link rel="preload">` for the avatar, outside it.
 */
function parsed(html: string): string {
  const div = document.createElement('div')
  div.innerHTML = html
  div.normalize()
  return div.querySelector('a')!.outerHTML
}

describe('oaSignInHtml', () => {
  const cases: OaSignInHtmlOptions[] = [
    { href: '/auth/oa?next=%2F&x=1' },
    { href: '/auth/oa', variant: 'blue', label: 'Continue with OA', className: 'wide' },
    { href: '/auth/oa', variant: 'neutral', account: { email: 'ada@openathena.ai', name: 'Ada <Lovelace>' } },
    { href: '/auth/oa', account: { email: 'bob@openathena.ai', avatar: 'https://x.test/b.png?a=1&b=2' } },
  ]

  it('is `<OaSignInButton>`\'s markup, for each layout and variant', () => {
    expect(cases.map(c => parsed(oaSignInHtml(c)))).toEqual(cases.map(c => parsed(renderToStaticMarkup(<OaSignInButton {...c} />))))
  })

  it('escapes what it interpolates', () => {
    const div = document.createElement('div')
    div.innerHTML = oaSignInHtml({ href: '/auth/oa?next=%2F&x="><b>', label: '<i>hi</i>', className: 'a" onclick="x' })
    const a = div.querySelector('a')!
    expect([div.children.length, a.getAttribute('href'), a.className, a.getAttributeNames(), a.querySelector('.oa-signin-label')!.textContent]).toEqual([
      1, '/auth/oa?next=%2F&x="><b>', 'oa-signin oa-signin-taupe a" onclick="x', ['class', 'href'], '<i>hi</i>',
    ])
  })
})
