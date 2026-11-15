// How events group into bursts (one burst, one thread): inactivity gap, a cap on span, how long a tab resumes its
// own burst, and one burst per actor or per tab.
import { afterEach, describe, expect, it } from 'vitest'
import { activityFeed, type ActivityFeedOptions } from '../src/activity/index.js'
import { d1ActivityStore } from '../src/adapters/d1-activity.js'
import { testDbRaw } from './d1-shim.js'

const actor = { id: 'grant:g1', name: 'Ada', via: 'grant' }
const close: (() => void)[] = []
afterEach(() => { close.splice(0).forEach(done => done()) })

/** Record `[ts, sessionId?]` events in order; returns each one's burst as a letter, A for the first burst seen. */
async function group(events: [number, string?][], options: Omit<ActivityFeedOptions, 'store'> = {}): Promise<string> {
  const { db, raw } = testDbRaw(['activity'])
  close.push(() => raw.close())
  let clock = 0
  const feed = activityFeed({ store: d1ActivityStore(db), now: () => clock, ...options })
  const names = new Map<string, string>()
  let out = ''
  for (const [i, [ts, sessionId]] of events.entries()) {
    clock = ts
    const { burstId } = await feed.record({ id: `e${i}`, actor, origin: 'https://app.example', ts, kind: 'view', path: '/', ...(sessionId ? { sessionId } : {}) })
    if (!names.has(burstId!)) names.set(burstId!, String.fromCharCode(65 + names.size))
    out += names.get(burstId!)
  }
  return out
}

describe('activity grouping', () => {
  it('an inactivity gap starts a new burst', async () => {
    expect(await group([[0], [900], [1801], [1802]], { gapS: 900 })).toBe('AABB')
  })

  it('maxSpanS caps a burst even without a gap', async () => {
    const steady = Array.from({ length: 9 }, (_, i) => [i * 600] as [number])
    expect([await group(steady, { gapS: 900 }), await group(steady, { gapS: 900, maxSpanS: 3600 })]).toEqual(['AAAAAAAAA', 'AAAAAAABB'])
  })

  it('resumeS bounds how long a tab rejoins its own burst, and 0 turns resuming off', async () => {
    const back = [[0, 't1'], [7200, 't1']] as [number, string][]
    expect([
      await group(back),
      await group(back, { resumeS: 3600 }),
      await group(back, { resumeS: 0 }),
    ]).toEqual(['AA', 'AB', 'AB'])
  })

  it("by: 'session' gives each tab its own burst; an event with no session joins the actor's latest", async () => {
    const tabs = [[0, 't1'], [10, 't2'], [20, 't1'], [30], [40, 't2'], [5000, 't1']] as [number, string?][]
    expect([await group(tabs), await group(tabs, { by: 'session' })]).toEqual(['AAAAAA', 'ABAABA'])
  })

  it('refuses nonsense', () => {
    const { db, raw } = testDbRaw(['activity'])
    close.push(() => raw.close())
    const store = d1ActivityStore(db)
    expect([
      () => activityFeed({ store, gapS: 0 }),
      () => activityFeed({ store, resumeS: -1 }),
      () => activityFeed({ store, maxSpanS: 0 }),
      () => activityFeed({ store, by: 'tab' as 'session' }),
    ].map(f => { try { f(); return 'ok' } catch (e) { return (e as Error).message } })).toEqual([
      'activity: invalid gap',
      'activity: invalid resume window',
      'activity: invalid max span',
      'activity: group by actor or session',
    ])
  })
})
