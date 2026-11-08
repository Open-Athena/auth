import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useId, useState, type FormEvent } from 'react'
import type { ActivityBurst, ActivityKind, ActivityMode } from '../../activity/types.js'
import { activityEndpoint, activityJson, activityKeys, type ActivityKindsPage, type ActivityPage } from './api.js'

export interface ActivityProps {
  /** Staff-only activityRoutes base path. Requires a QueryClientProvider. */
  endpoint?: string
  className?: string
}

const modes: ActivityMode[] = ['off', 'count', 'line']
const countLabel = (counts: Record<string, number>) => Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)).map(([kind, count]) => `${kind}: ${count}`).join(', ') || 'None'
const clock = (ts: number) => new Date(ts * 1000).toLocaleString()
const Time = ({ ts }: { ts: number }) => <time dateTime={new Date(ts * 1000).toISOString()}>{clock(ts)}</time>

function BurstDetail({ endpoint, id }: { endpoint: string; id: string }) {
  const query = useQuery({
    queryKey: [...activityKeys(endpoint), 'burst', id],
    queryFn: ({ signal }) => activityJson<{ burst: ActivityBurst }>(`${endpoint}/${encodeURIComponent(id)}`, { signal }),
    retry: false, gcTime: 0,
  })
  return <section className="oa-activity-detail" aria-label="Burst detail" aria-busy={query.isFetching}>
    {query.isPending && <p role="status">Loading detail...</p>}
    {query.error && <p role="alert">{query.error.message}</p>}
    {query.data && <>
      <h3>{query.data.burst.actor.name}</h3>
      <p>{query.data.burst.actor.id} / {query.data.burst.actor.via}</p>
      <p>{query.data.burst.origin}</p>
      <p>Recorded: {countLabel(query.data.burst.counts)}</p>
      <p>Notifications: {countLabel(query.data.burst.notifyCounts)}</p>
      {query.data.burst.lines.length === 0 ? <p>No recorded lines.</p> : <ol className="oa-activity-lines">
        {query.data.burst.lines.map(line => <li key={line.id}>
          <Time ts={line.ts} /> <strong>{line.kind}</strong> <span>{line.line ?? line.path ?? 'No detail'}</span>
          {line.path && line.line !== line.path && <code>{line.path}</code>}
          {line.sessionId && <span>Session: {line.sessionId}</span>}
        </li>)}
      </ol>}
      {query.data.burst.omittedLines > 0 && <p>{query.data.burst.omittedLines} older lines omitted.</p>}
    </>}
  </section>
}

export function ActivityList({ endpoint = '/api/activity', className = '' }: ActivityProps) {
  const base = activityEndpoint(endpoint)
  const [actorId, setActorId] = useState('')
  const [origin, setOrigin] = useState('')
  const [since, setSince] = useState('')
  const [limit, setLimit] = useState('100')
  const [search, setSearch] = useState('limit=100')
  const [selected, setSelected] = useState<string | null>(null)
  const detailId = useId()
  const query = useQuery({
    queryKey: [...activityKeys(base), 'bursts', search],
    queryFn: ({ signal }) => activityJson<ActivityPage>(`${base}?${search}`, { signal }),
    retry: false, gcTime: 0,
  })
  function filter(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const params = new URLSearchParams()
    if (actorId.trim()) params.set('actorId', actorId.trim())
    if (origin.trim()) params.set('origin', origin.trim())
    if (since) params.set('since', String(Math.floor(new Date(since).getTime() / 1000)))
    params.set('limit', limit)
    setSelected(null)
    setSearch(params.toString())
  }
  return <section className={`oa-activity ${className}`} aria-label="Activity bursts">
    <h2>Activity</h2>
    <form className="oa-activity-filters" onSubmit={filter}>
      <label>Actor ID<input type="search" value={actorId} maxLength={512} onChange={event => setActorId(event.target.value)} /></label>
      <label>Origin<input type="search" value={origin} maxLength={512} onChange={event => setOrigin(event.target.value)} /></label>
      <label>Active since<input type="datetime-local" value={since} onChange={event => setSince(event.target.value)} /></label>
      <label>Limit<select value={limit} onChange={event => setLimit(event.target.value)}>
        {[25, 50, 100, 250, 500].map(value => <option key={value} value={value}>{value}</option>)}
      </select></label>
      <button type="submit">Apply filters</button>
      <button type="button" disabled={query.isFetching} onClick={() => void query.refetch()}>Refresh</button>
    </form>
    <div aria-busy={query.isFetching}>
      {query.isFetching && <p role="status">Loading activity...</p>}
      {query.error && <p role="alert">{query.error.message}</p>}
      {query.data && !query.error && <>
        {query.data.bursts.length === 0 ? <p role="status">No activity matches these filters.</p> : <div className="oa-activity-scroll">
          <table>
            <caption>Recent activity bursts</caption>
            <thead><tr>{['Actor', 'Origin', 'First seen', 'Last seen', 'Recorded', 'Detail'].map(label => <th scope="col" key={label}>{label}</th>)}</tr></thead>
            <tbody>{query.data.bursts.map(burst => <tr key={burst.id}>
              <th scope="row"><span>{burst.actor.name}</span><small>{burst.actor.id} / {burst.actor.via}</small></th>
              <td>{burst.origin}</td><td><Time ts={burst.firstTs} /></td><td><Time ts={burst.lastTs} /></td>
              <td>{countLabel(burst.counts)}</td>
              <td><button type="button" aria-label={`${selected === burst.id ? 'Close' : 'View'} burst for ${burst.actor.name}`} aria-expanded={selected === burst.id} aria-controls={selected === burst.id ? detailId : undefined} onClick={() => setSelected(selected === burst.id ? null : burst.id)}>{selected === burst.id ? 'Close' : 'View'}</button></td>
            </tr>)}</tbody>
          </table>
        </div>}
      </>}
    </div>
    {selected && <div id={detailId}><BurstDetail key={`${base}/${selected}`} endpoint={base} id={selected} /></div>}
  </section>
}

function KindRow({ endpoint, kind, policy }: { endpoint: string; kind: string; policy: ActivityKind }) {
  const client = useQueryClient()
  const [draft, setDraft] = useState(policy)
  const mutation = useMutation({
    mutationFn: () => activityJson<ActivityKindsPage>(`${endpoint}/kinds/${encodeURIComponent(kind)}`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(draft),
    }),
    onSuccess: data => { client.setQueryData([...activityKeys(endpoint), 'kinds'], data) },
  })
  const changed = draft.record !== policy.record || draft.notify !== policy.notify
  return <tr>
    <th scope="row">{kind}</th>
    <td><select aria-label={`Record ${kind}`} value={draft.record} disabled={mutation.isPending} onChange={event => {
      const record = event.target.value as ActivityMode
      setDraft({ record, notify: modes.indexOf(draft.notify) > modes.indexOf(record) ? record : draft.notify })
      mutation.reset()
    }}>{modes.map(mode => <option key={mode} value={mode}>{mode}</option>)}</select></td>
    <td><select aria-label={`Notify ${kind}`} value={draft.notify} disabled={mutation.isPending} onChange={event => {
      setDraft({ ...draft, notify: event.target.value as ActivityMode })
      mutation.reset()
    }}>{modes.map(mode => <option key={mode} value={mode} disabled={modes.indexOf(mode) > modes.indexOf(draft.record)}>{mode}</option>)}</select></td>
    <td><button type="button" aria-label={`Save ${kind} policy`} disabled={!changed || mutation.isPending} onClick={() => mutation.mutate()}>{mutation.isPending ? 'Saving...' : 'Save'}</button>
      {mutation.error && <p role="alert">{mutation.error.message}</p>}
    </td>
  </tr>
}

export function ActivityKindSettings({ endpoint = '/api/activity', className = '' }: ActivityProps) {
  const base = activityEndpoint(endpoint)
  const query = useQuery({
    queryKey: [...activityKeys(base), 'kinds'],
    queryFn: ({ signal }) => activityJson<ActivityKindsPage>(`${base}/kinds`, { signal }),
    retry: false, gcTime: 0,
  })
  return <section className={`oa-activity ${className}`} aria-label="Activity kind settings" aria-busy={query.isFetching}>
    <h2>Kind settings</h2>
    {query.isPending && <p role="status">Loading kind settings...</p>}
    {query.error && <><p role="alert">{query.error.message}</p><button type="button" disabled={query.isFetching} onClick={() => void query.refetch()}>Retry settings</button></>}
    {query.data && !query.error && <>
      {Object.keys(query.data.kinds).length === 0 ? <p role="status">No activity kinds configured.</p> : <div className="oa-activity-scroll">
        <table><caption>Recording and notification policies</caption>
          <thead><tr>{['Kind', 'Record', 'Notify', 'Save'].map(label => <th scope="col" key={label}>{label}</th>)}</tr></thead>
          <tbody>{Object.entries(query.data.kinds).sort(([a], [b]) => a.localeCompare(b)).map(([kind, policy]) => <KindRow key={`${base}/${kind}/${policy.record}/${policy.notify}`} endpoint={base} kind={kind} policy={policy} />)}</tbody>
        </table>
      </div>}
    </>}
  </section>
}

export function ActivityAdmin(props: ActivityProps) {
  return <div className="oa-activity-admin"><ActivityList {...props} /><ActivityKindSettings {...props} /></div>
}
