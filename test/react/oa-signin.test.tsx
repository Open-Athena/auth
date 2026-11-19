// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { OaSignInButton } from '../../src/react/OaSignInButton.js'

afterEach(cleanup)

/** The link's class, href, and its children's classes and text, in order. */
function shape(el: HTMLElement) {
  const a = el.querySelector('a')!
  return {
    className: a.className,
    href: a.getAttribute('href'),
    parts: [...a.children].map(c => [c.getAttribute('class'), c.textContent]),
  }
}

describe('OaSignInButton', () => {
  it('defaults to the taupe variant, the OA mark first, "Sign in with OA" centered', () => {
    const { container } = render(<OaSignInButton href="/auth/oa?next=%2F" />)
    expect(shape(container)).toEqual({
      className: 'oa-signin oa-signin-taupe',
      href: '/auth/oa?next=%2F',
      parts: [['oa-signin-logo', ''], ['oa-signin-label', 'Sign in with OA'], ['oa-signin-spacer', '']],
    })
    expect([...container.querySelectorAll('.oa-signin-mark g')].map(g => [g.getAttribute('class'), g.children.length])).toEqual([
      ['oa-signin-ring', 3],
      ['oa-signin-stem', 2],
    ])
  })

  it('takes a variant, a label, and another org\'s brand', () => {
    const { container } = render(
      <OaSignInButton href="/auth/x" variant="blue" label="Continue with Acme" brand={{ name: 'Acme', mark: <b>A</b> }} className="wide" />,
    )
    expect(shape(container)).toEqual({
      className: 'oa-signin oa-signin-blue wide',
      href: '/auth/x',
      parts: [['oa-signin-logo', 'A'], ['oa-signin-label', 'Continue with Acme'], ['oa-signin-spacer', '']],
    })
  })

  it('a returning account: face, "Continue as <first name>" over the address, the mark last', () => {
    const named = render(<OaSignInButton href="/auth/oa" variant="neutral" account={{ email: 'ada@openathena.ai', name: 'Ada Lovelace' }} />)
    const bare = render(<OaSignInButton href="/auth/oa" account={{ email: 'bob@openathena.ai', avatar: 'https://x.test/b.png' }} />)
    expect([shape(named.container), shape(bare.container), bare.container.querySelector('img')!.getAttribute('src')]).toEqual([
      {
        className: 'oa-signin oa-signin-neutral oa-signin-account',
        href: '/auth/oa',
        parts: [['oa-signin-avatar', 'A'], ['oa-signin-who', 'Continue as Adaada@openathena.ai'], ['oa-signin-logo', '']],
      },
      {
        className: 'oa-signin oa-signin-taupe oa-signin-account',
        href: '/auth/oa',
        parts: [['oa-signin-avatar', ''], ['oa-signin-who', 'Continue as bob@openathena.ai'], ['oa-signin-logo', '']],
      },
      'https://x.test/b.png',
    ])
  })
})
