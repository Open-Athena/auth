import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { memo, type ReactNode, useCallback, useMemo, useRef, useState } from 'react'
import type { SessionDetail, SessionPage, SessionRow } from '../../core/session-log-shape.js'
import {
  fmtClock,
  fmtDuration,
  fmtOffset,
  LANES,
  type Line,
  pagerLabel,
  relAgo,
  sessionsQuery,
  ticks,
  timeline,
  uaLabel,
} from './model.js'

async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url, { credentials: 'same-origin' })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error((j as { error?: string }).error ?? `HTTP ${r.status}`)
  return j as T
}

const fmtTime = (ms: number): string =>
  new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' })

/** How the viewer renders a link: a plain `<a>` by default; pass your router's `Link` for in-app navigation. */
export type RenderLink = (p: { href: string; className?: string; children: ReactNode }) => ReactNode
const plainLink: RenderLink = ({ href, className, children }) => (
  <a href={href} className={className}>
    {children}
  </a>
)

/** Who a session was, by default: the address, else "anonymous", and a share-link session is tagged as such. */
export function DefaultViewer({ s }: { s: Pick<SessionRow, 'email' | 'via'> }) {
  return (
    <span className="oa-slog-who">
      {s.email ? <span>{s.email}</span> : s.via !== 'grant' && <em>anonymous</em>}
      {s.via === 'grant' && (
        <>
          {s.email && <span className="oa-slog-dim"> · </span>}
          <span className="oa-slog-guest">share link{s.email ? '' : ', no address'}</span>
        </>
      )}
    </span>
  )
}

/** The list's filters and page, as its URL would hold them (`u`, `since`, `err`, `after` / `before`). */
export interface SessionListParams {
  email: string
  since: string
  errors: boolean
  after: string | null
  before: string | null
}

export const EMPTY_PARAMS: SessionListParams = { email: '', since: '', errors: false, after: null, before: null }

export interface SessionListProps {
  /** The session-log routes' base path (default `/api/session-log`). */
  endpoint?: string
  /** Controlled filters and page (keep them in your URL); uncontrolled when absent. */
  params?: SessionListParams
  onParams?: (next: SessionListParams, opts: { replace: boolean }) => void
  /** A session's timeline page. */
  sessionHref: (sid: string) => string
  renderLink?: RenderLink
  /** Who a row was (e.g. your app's user chip); `DefaultViewer` otherwise. */
  renderViewer?: (s: SessionRow) => ReactNode
  className?: string
}

/** Sessions, most recently active first, 50 a page, filterable by address, start date and errors. */
export function SessionList({
  endpoint = '/api/session-log',
  params: controlled,
  onParams,
  sessionHref,
  renderLink = plainLink,
  renderViewer = s => <DefaultViewer s={s} />,
  className = 'oa-slog',
}: SessionListProps) {
  const [own, setOwn] = useState(EMPTY_PARAMS)
  const params = controlled ?? own
  const update = (next: SessionListParams, replace: boolean) => (onParams ? onParams(next, { replace }) : setOwn(next))
  /** A filter change returns to the first page. */
  const set = (patch: Partial<SessionListParams>) => update({ ...params, ...patch, after: null, before: null }, true)
  const go = (k: 'after' | 'before', c: string) =>
    update({ ...params, after: k === 'after' ? c : null, before: k === 'before' ? c : null }, false)
  const qs = sessionsQuery(params)
  const q = useQuery({
    queryKey: ['oa-session-log', endpoint, 'sessions', qs],
    queryFn: () => getJson<SessionPage>(`${endpoint}/sessions${qs ? `?${qs}` : ''}`),
    placeholderData: keepPreviousData,
  })
  const pager = q.data && <Pager page={q.data} onGo={go} />
  return (
    <div className={className}>
      <div className="oa-slog-filters">
        <label>
          viewer{' '}
          <input
            type="search"
            name="oa-slog-viewer"
            autoComplete="off"
            data-1p-ignore=""
            data-lpignore="true"
            value={params.email}
            onChange={e => set({ email: e.target.value })}
            placeholder="address contains…"
            size={22}
          />
        </label>
        <label>
          active since <input type="date" value={params.since} onChange={e => set({ since: e.target.value })} />
        </label>
        <label>
          <input type="checkbox" checked={params.errors} onChange={e => set({ errors: e.target.checked })} /> with errors
        </label>
      </div>
      {q.error && <p className="oa-slog-err">{q.error.message}</p>}
      {pager}
      <div className="oa-slog-scroll">
        <table className="oa-slog-table">
          <thead>
            <tr>
              <th>viewer</th>
              <th>last active</th>
              <th>started</th>
              <th className="oa-slog-num">duration</th>
              <th className="oa-slog-num">events</th>
              <th className="oa-slog-num">errors</th>
              <th>browser</th>
              <th>build</th>
            </tr>
          </thead>
          <tbody>
            {(q.data?.sessions ?? []).map(s => (
              <tr key={s.sid} className={s.n_errors ? 'oa-slog-has-err' : ''}>
                <td>{renderViewer(s)}</td>
                <td>
                  {renderLink({ href: sessionHref(s.sid), className: 'oa-slog-when', children: relAgo(s.last_ms) })}
                  <div className="oa-slog-dim">{fmtTime(s.last_ms)}</div>
                </td>
                <td>{fmtTime(s.started_ms)}</td>
                <td className="oa-slog-num">{fmtDuration(s.last_ms - s.started_ms)}</td>
                <td className="oa-slog-num">{s.n_events.toLocaleString()}</td>
                <td className="oa-slog-num">
                  {s.n_errors ? <b className="oa-slog-err">{s.n_errors}</b> : <span className="oa-slog-dim">0</span>}
                </td>
                <td>{uaLabel(s.ua)}</td>
                <td>
                  <code>{s.build ?? '—'}</code>
                </td>
              </tr>
            ))}
            {q.data && !q.data.sessions.length && (
              <tr>
                <td colSpan={8}>
                  <em>no sessions match</em>
                </td>
              </tr>
            )}
            {q.isPending && (
              <tr>
                <td colSpan={8} className="oa-slog-dim">
                  Loading sessions…
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {q.data && q.data.sessions.length > 10 && pager}
    </div>
  )
}

/** "51–100 of 312" with prev / next: the page's cursors (`prev` / `next`), disabled at either end. */
function Pager({ page, onGo }: { page: SessionPage; onGo: (k: 'after' | 'before', c: string) => void }) {
  const { prev, next } = page
  return (
    <nav className="oa-slog-pager" aria-label="Pages">
      <button type="button" disabled={!prev} onClick={() => prev && onGo('before', prev)}>
        ← newer
      </button>
      <span>{pagerLabel(page)}</span>
      <button type="button" disabled={!next} onClick={() => next && onGo('after', next)}>
        older →
      </button>
    </nav>
  )
}

const KIND_FILTERS = [
  { id: 'all', label: 'all' },
  { id: 'errors', label: 'errors' },
  { id: 'actions', label: 'actions' },
  { id: 'app', label: 'app' },
  { id: 'api', label: 'requests' },
] as const
type KindFilter = (typeof KIND_FILTERS)[number]['id']
const shown = (l: Line, f: KindFilter): boolean =>
  f === 'all' ||
  (f === 'errors'
    ? l.error
    : f === 'actions'
      ? l.lane === 'input' || l.lane === 'nav'
      : f === 'app'
        ? l.lane === 'app'
        : l.k === 'api')

export interface SessionViewProps {
  sid: string
  endpoint?: string
  renderViewer?: (s: SessionRow) => ReactNode
  className?: string
}

/** One session: a strip of its events over time, then the timeline table, each row with "open this view". */
export function SessionView({
  sid,
  endpoint = '/api/session-log',
  renderViewer = s => <DefaultViewer s={s} />,
  className = 'oa-slog',
}: SessionViewProps) {
  const q = useQuery({
    queryKey: ['oa-session-log', endpoint, 'session', sid],
    queryFn: () => getJson<SessionDetail>(`${endpoint}/sessions/${encodeURIComponent(sid)}`),
  })
  const lines = useMemo(() => timeline(q.data?.events ?? []), [q.data])
  const [filter, setFilter] = useState<KindFilter>('all')
  const [focus, setFocus] = useState<number | null>(null)
  /** The event under the pointer, in the strip or the table: both highlight it. */
  const [hot, setHot] = useState<number | null>(null)
  const rows = useRef(new Map<number, HTMLTableRowElement>())
  const box = useRef<HTMLDivElement>(null)
  const rowRef = useCallback((i: number, el: HTMLTableRowElement | null) => {
    if (el) rows.current.set(i, el)
    else rows.current.delete(i)
  }, [])
  /** A strip hover brings its row into the table's own scroll box (never the page's: the strip stays in view). */
  const stripHover = useCallback((i: number | null) => {
    setHot(i)
    const row = i === null ? undefined : rows.current.get(i)
    const b = box.current
    if (!row || !b) return
    const r = row.getBoundingClientRect()
    const bb = b.getBoundingClientRect()
    const head = b.querySelector('thead')?.getBoundingClientRect().height ?? 0
    if (r.top < bb.top + head || r.bottom > bb.bottom) b.scrollTop += r.top - bb.top - (bb.height - r.height) / 2
  }, [])
  if (q.error) return <p className="oa-slog-err">{q.error.message}</p>
  if (!q.data) return <p className="oa-slog-dim">Loading session…</p>
  const s = q.data.session
  const t0 = lines[0]?.t ?? s.started_ms
  const jump = (i: number) => {
    setFilter('all')
    setFocus(i)
    requestAnimationFrame(() => rows.current.get(i)?.scrollIntoView({ block: 'center', behavior: 'smooth' }))
  }
  return (
    <div className={className}>
      <h1>{renderViewer(s)}</h1>
      <p className="oa-slog-meta">
        {fmtTime(s.started_ms)} · {fmtDuration(s.last_ms - s.started_ms)} · {s.n_events.toLocaleString()} events ·{' '}
        {s.n_errors ? <b className="oa-slog-err">{s.n_errors} {s.n_errors === 1 ? 'error' : 'errors'}</b> : '0 errors'} · {uaLabel(s.ua)} · build{' '}
        <code>{s.build ?? '—'}</code> · <code className="oa-slog-dim">{s.sid}</code>
      </p>
      <Strip lines={lines} hot={hot} onHover={stripHover} onPick={jump} />
      <div className="oa-slog-filters" role="radiogroup" aria-label="Show">
        {KIND_FILTERS.map(f => (
          <label key={f.id}>
            <input type="radio" name="oa-slog-kind" checked={filter === f.id} onChange={() => setFilter(f.id)} /> {f.label}
          </label>
        ))}
      </div>
      <div className="oa-slog-scroll oa-slog-timeline-box" ref={box}>
        <table className="oa-slog-table oa-slog-timeline">
          <thead>
            <tr>
              <th className="oa-slog-num">at</th>
              <th className="oa-slog-num">time</th>
              <th>kind</th>
              <th>event</th>
              <th></th>
            </tr>
          </thead>
          <tbody onMouseLeave={() => setHot(null)}>
            {lines
              .filter(l => shown(l, filter))
              .map(l => (
                <EventRow key={l.i} l={l} t0={t0} hot={hot === l.i} focused={focus === l.i} rowRef={rowRef} onHover={setHot} />
              ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/** One timeline row; memoized, so a hover re-renders two rows, not the whole (up to 20K-row) table. */
const EventRow = memo(function EventRow({
  l,
  t0,
  hot,
  focused,
  rowRef,
  onHover,
}: {
  l: Line
  t0: number
  hot: boolean
  focused: boolean
  rowRef: (i: number, el: HTMLTableRowElement | null) => void
  onHover: (i: number) => void
}) {
  const cls = [l.error && 'oa-slog-has-err', focused && 'oa-slog-focused', hot && 'oa-slog-hot', l.k === 'start' && 'oa-slog-load']
  return (
    <tr ref={el => rowRef(l.i, el)} onMouseEnter={() => onHover(l.i)} className={cls.filter(Boolean).join(' ')}>
      <td className="oa-slog-num">
        <code>{fmtOffset(l.off)}</code>
      </td>
      <td className="oa-slog-num">
        <code className="oa-slog-dim">{fmtClock(l.t, t0)}</code>
      </td>
      <td className="oa-slog-kind">
        <span className={`oa-slog-dot oa-slog-lane-${l.lane}`} aria-hidden /> {l.k}
      </td>
      <td className="oa-slog-ev">{l.text}</td>
      <td className="oa-slog-open">
        {l.url && (
          <a href={l.url} target="_blank" rel="noreferrer" aria-label={`open the view as it was: ${l.url}`}>
            open view ↗
          </a>
        )}
      </td>
    </tr>
  )
})

const STRIP_W = 1000
const LANE_H = 14

/**
 * The session on a time axis: one lane per event family, errors red; hover
 * names the event (and highlights its table row), click jumps to it. `hot` is
 * the event hovered here or in the table: a full-height guide marks it.
 */
function Strip({
  lines,
  hot,
  onHover,
  onPick,
}: {
  lines: Line[]
  hot: number | null
  onHover: (i: number | null) => void
  onPick: (i: number) => void
}) {
  const tks = useMemo(() => ticks(lines, STRIP_W), [lines])
  const [hover, setHover] = useState<{ i: number; x: number; y: number } | null>(null)
  const marks = useMemo(
    () =>
      tks.map(t => (
        <line
          key={t.i}
          x1={t.x}
          x2={t.x}
          y1={LANES.indexOf(t.lane) * LANE_H + 2}
          y2={(LANES.indexOf(t.lane) + 1) * LANE_H - 2}
          className={`oa-slog-tick oa-slog-lane-${t.lane}${t.error ? ' oa-slog-tick-err' : ''}`}
          vectorEffect="non-scaling-stroke"
        />
      )),
    [tks],
  )
  const fig = useRef<HTMLElement>(null)
  const svg = useRef<SVGSVGElement>(null)
  const last = lines[lines.length - 1]
  if (!last) return null
  const nearest = (clientX: number): number | null => {
    const r = svg.current?.getBoundingClientRect()
    if (!r || !r.width) return null
    const x = ((clientX - r.left) / r.width) * STRIP_W
    let best: number | null = null
    let d = Infinity
    for (const t of tks) {
      const dd = Math.abs(t.x - x)
      if (dd < d) {
        d = dd
        best = t.i
      }
    }
    return d <= 8 ? best : null
  }
  const h = LANES.length * LANE_H
  const hovered = hover !== null ? lines[hover.i] : undefined
  const hotTick = hot !== null ? tks[hot] : undefined
  return (
    <figure className="oa-slog-strip" ref={fig}>
      <svg
        ref={svg}
        viewBox={`0 0 ${STRIP_W} ${h}`}
        preserveAspectRatio="none"
        role="img"
        aria-label="Events over the session"
        onMouseMove={e => {
          const i = nearest(e.clientX)
          onHover(i)
          const box = fig.current?.getBoundingClientRect()
          setHover(i === null || !box ? null : { i, x: e.clientX - box.left, y: e.clientY - box.top })
        }}
        onMouseLeave={() => {
          setHover(null)
          onHover(null)
        }}
        onClick={e => {
          const i = nearest(e.clientX)
          if (i !== null) onPick(i)
        }}
      >
        {LANES.map((lane, li) => (
          <rect key={lane} x={0} y={li * LANE_H} width={STRIP_W} height={LANE_H} className={`oa-slog-lane-bg oa-slog-lane-${lane}`} />
        ))}
        {marks}
        {hotTick && (
          <line x1={hotTick.x} x2={hotTick.x} y1={0} y2={h} className="oa-slog-guide" vectorEffect="non-scaling-stroke" />
        )}
      </svg>
      <figcaption>
        <span className="oa-slog-lanes">
          {LANES.map(l => (
            <span key={l}>
              <span className={`oa-slog-dot oa-slog-lane-${l}`} aria-hidden /> {l}
            </span>
          ))}
        </span>
        <span className="oa-slog-dim">
          {fmtOffset(0)} → {fmtOffset(last.off)}
        </span>
      </figcaption>
      {hovered && hover && (
        <div className="oa-slog-tip" role="tooltip" style={{ left: hover.x, top: hover.y }}>
          <b>{fmtOffset(hovered.off)}</b> {hovered.k}: {hovered.text}
          <div className="oa-slog-dim">click to jump to it</div>
        </div>
      )}
    </figure>
  )
}
