import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { type ReactNode, useState } from 'react'
import { lastDay, type SwitchState } from '../../core/session-log-shape.js'

const day = (epochS: number): string => new Date(epochS * 1000).toISOString().slice(0, 10)

/** The switch's one-line status. */
export function switchStatus(s: SwitchState): string {
  const by = s.who && s.ts !== null ? ` Set by ${s.who} on ${day(s.ts)}.` : ''
  if (s.reason === 'not set up') {
    return 'Not set up on this deployment (no session_log tables): apply migrations/session-log/.'
  }
  if (s.enabled && s.indefinite) return `On (no end date).${by}`
  if (s.enabled && s.until !== null) return `On through ${lastDay(s.until)} (UTC).${by}`
  if (s.reason === 'expired' && s.until !== null) return `Off: ended after ${lastDay(s.until)} (UTC).${by}`
  return `Off.${by}`
}

/** The end an admin has picked: through a date, or no end date. */
export type SwitchEnd = 'dated' | 'indefinite'

export interface SessionLogSwitchViewProps {
  state: SwitchState
  /** Today's UTC date: the earliest a new end may be. */
  today: string
  /** The date field's value (`YYYY-MM-DD`). */
  date: string
  onDate: (d: string) => void
  end: SwitchEnd
  onEnd: (e: SwitchEnd) => void
  /** Turn on with the chosen end (also: change the end while on), or off. */
  onSet: (enabled: boolean) => void
  busy: boolean
  error: string | null
  /** Shown under the heading (what's recorded, where to read it). */
  description?: ReactNode
  className?: string
}

/** The switch, as markup (pure: `SessionLogSwitch` wires it to the API). */
export function SessionLogSwitchView({
  state,
  today,
  date,
  onDate,
  end,
  onEnd,
  onSet,
  busy,
  error,
  description,
  className = 'oa-slog-switch',
}: SessionLogSwitchViewProps) {
  const setUp = state.reason !== 'not set up'
  const changed =
    state.enabled &&
    (end === 'indefinite' ? !state.indefinite : state.indefinite || (state.until !== null && date !== lastDay(state.until)))
  return (
    <section className={className}>
      <h2>Session log</h2>
      {description}
      <p className="oa-slog-status">{switchStatus(state)}</p>
      {setUp && (
        <form
          onSubmit={e => {
            e.preventDefault()
            onSet(true)
          }}
        >
          <label className="oa-slog-toggle">
            <input
              type="checkbox"
              role="switch"
              checked={state.enabled}
              disabled={busy}
              onChange={e => onSet(e.target.checked)}
            />{' '}
            Logging
          </label>
          <span className="oa-slog-ends" role="radiogroup" aria-label="Ends">
            <label>
              <input
                type="radio"
                name="oa-slog-end"
                checked={end === 'dated'}
                disabled={busy}
                onChange={() => onEnd('dated')}
              />{' '}
              through{' '}
              <input
                type="date"
                value={date}
                min={today}
                max={lastDay(state.maxUntil)}
                disabled={busy}
                onChange={e => {
                  onDate(e.target.value)
                  onEnd('dated')
                }}
              />{' '}
              (UTC)
            </label>
            <label>
              <input
                type="radio"
                name="oa-slog-end"
                checked={end === 'indefinite'}
                disabled={busy}
                onChange={() => onEnd('indefinite')}
              />{' '}
              no end date
            </label>
          </span>
          {changed && (
            <button type="submit" disabled={busy}>
              Set end
            </button>
          )}
        </form>
      )}
      {error && <p className="oa-slog-err">{error}</p>}
    </section>
  )
}

async function call(endpoint: string, init?: RequestInit): Promise<SwitchState> {
  const r = await fetch(`${endpoint}/switch`, { credentials: 'same-origin', cache: 'no-store', ...init })
  const body = (await r.json().catch(() => null)) as (SwitchState & { error?: string }) | null
  if (!r.ok) throw new Error(body?.error ?? `session-log switch: ${r.status}`)
  return body as SwitchState
}

export interface SessionLogSwitchProps {
  /** The session-log routes' base path (default `/api/session-log`). */
  endpoint?: string
  description?: ReactNode
  className?: string
}

/**
 * The admin switch: on through a UTC date (default 7 days, at most 31), on
 * with no end date (until an admin turns it off), or off. A dated run ends by
 * itself after its date.
 */
export function SessionLogSwitch({ endpoint = '/api/session-log', description, className }: SessionLogSwitchProps) {
  const qc = useQueryClient()
  const key = ['oa-session-log', endpoint, 'switch']
  const q = useQuery<SwitchState, Error>({ queryKey: key, queryFn: () => call(endpoint) })
  const [draft, setDraft] = useState<string | null>(null)
  const [endDraft, setEndDraft] = useState<SwitchEnd | null>(null)
  const set = useMutation<SwitchState, Error, { enabled: boolean; until: string; end: SwitchEnd }>({
    mutationFn: ({ enabled, until, end }) =>
      call(endpoint, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(!enabled ? { enabled } : end === 'indefinite' ? { enabled, indefinite: true } : { enabled, until }),
      }),
    onSuccess: s => {
      qc.setQueryData(key, s)
      setDraft(null)
      setEndDraft(null)
    },
  })
  if (q.error) {
    return (
      <section className={className ?? 'oa-slog-switch'}>
        <h2>Session log</h2>
        <p className="oa-slog-err">{q.error.message}</p>
      </section>
    )
  }
  if (!q.data) return null
  const s = q.data
  const date = draft ?? lastDay(s.enabled && !s.indefinite && s.until !== null ? s.until : s.defaultUntil)
  const end = endDraft ?? (s.indefinite ? 'indefinite' : 'dated')
  return (
    <SessionLogSwitchView
      state={s}
      today={new Date().toISOString().slice(0, 10)}
      date={date}
      onDate={setDraft}
      end={end}
      onEnd={setEndDraft}
      onSet={enabled => set.mutate({ enabled, until: date, end })}
      busy={set.isPending}
      error={set.error?.message ?? null}
      description={description}
      className={className}
    />
  )
}
