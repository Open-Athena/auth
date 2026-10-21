import { expect, it } from 'vitest'
import { reportUnauthenticated, subscribeUnauthenticated } from '../src/client/auth-events.js'
import { isSessionLossReason, sessionLossMessage } from '../src/core/denial.js'

it('reports only a safe reason and explicit gate endpoint, with no retained global state', () => {
  const events: unknown[] = []
  const unsubscribe = subscribeUnauthenticated(event => events.push(event))
  reportUnauthenticated('revoked')
  reportUnauthenticated('expired', { endpoint: '/custom/whoami' })
  reportUnauthenticated()
  unsubscribe()
  reportUnauthenticated('delisted')
  expect(events).toEqual([
    { reason: 'revoked', endpoint: '/api/auth/whoami' },
    { reason: 'expired', endpoint: '/custom/whoami' },
    { reason: null, endpoint: '/api/auth/whoami' },
  ])
})

it('accepts only the public denial vocabulary, including safe prototype names', () => {
  expect(['revoked', 'expired', 'rotated', 'delisted', 'invalid', 'toString', '__proto__', 'bad-token', null, 0].map(isSessionLossReason)).toEqual([
    true, true, true, true, true, false, false, false, false, false,
  ])
  expect(sessionLossMessage('revoked')).toBe('This link was revoked.')
})
