import { type FormEvent, useCallback, useEffect, useState } from 'react'

/** One row as the `<basePath>/allowed` endpoint returns it. */
export interface AllowedEntry {
  email: string
  scopes: string[]
  source: string
  note: string | null
  addedBy: string | null
  updatedAt: number
}

type PanelState = 'loading' | 'idle' | 'saving' | 'error'

export interface AllowlistPanelProps {
  /** Default `/api/auth/allowed`. */
  endpoint?: string
  /**
   * Scopes to grant a hand-added email. Defaults to `[]` — set this to your
   * app's view scope (e.g. `['view']`) so the add form doesn't need a scopes
   * field. Rows a directory sync wrote keep whatever scopes it gave them.
   */
  defaultScopes?: readonly string[]
  /** Called after any successful add or remove. */
  onChanged?: () => void
  classNames?: Partial<
    Record<
      'root' | 'table' | 'row' | 'cell' | 'source' | 'form' | 'input' | 'button' | 'remove' | 'message' | 'empty',
      string
    >
  >
  labels?: Partial<Record<'email' | 'add' | 'adding' | 'remove' | 'empty' | 'synced' | 'manual', string>>
}

const DEFAULTS = {
  email: 'Email to allow',
  add: 'Add',
  adding: 'Adding…',
  remove: 'Remove',
  empty: 'No one is on the allowlist yet.',
  synced: 'synced',
  manual: 'manual',
}

/**
 * Manage the SSO allowlist: list allowed emails, add one, remove one. Unstyled
 * like the rest of `react/` — every visible string and class is a prop.
 *
 * A row's `source` distinguishes a hand-added address (`manual`) from one a
 * directory sync owns (`sync:…`); both are removable here, but a sync will
 * re-add the ones it manages on its next run, so removing a synced member is
 * only durable if you also take them out of the upstream group.
 */
export function AllowlistPanel({
  endpoint = '/api/auth/allowed',
  defaultScopes = [],
  onChanged,
  classNames = {},
  labels = {},
}: AllowlistPanelProps) {
  const t = { ...DEFAULTS, ...labels }
  const [rows, setRows] = useState<AllowedEntry[]>([])
  const [email, setEmail] = useState('')
  const [state, setState] = useState<PanelState>('loading')
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await fetch(endpoint, { credentials: 'include' })
      if (!res.ok) throw new Error(`${res.status}`)
      const body = (await res.json()) as { allowed: AllowedEntry[] }
      setRows(body.allowed)
      setState('idle')
    } catch {
      setState('error')
      setError('Could not load the allowlist.')
    }
  }, [endpoint])

  useEffect(() => {
    void load()
  }, [load])

  async function add(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const value = email.trim()
    if (!value || state === 'saving') return
    setState('saving')
    setError(null)
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: value, scopes: [...defaultScopes] }),
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(body.error ?? `${res.status}`)
      }
      setEmail('')
      await load()
      onChanged?.()
    } catch (err) {
      setState('error')
      setError(err instanceof Error ? err.message : 'Could not add that address.')
    }
  }

  async function remove(target: string) {
    setState('saving')
    setError(null)
    try {
      const res = await fetch(`${endpoint}/${encodeURIComponent(target)}`, { method: 'DELETE', credentials: 'include' })
      if (!res.ok) throw new Error(`${res.status}`)
      await load()
      onChanged?.()
    } catch {
      setState('error')
      setError('Could not remove that address.')
    }
  }

  return (
    <div className={classNames.root}>
      <form className={classNames.form} onSubmit={add}>
        <input
          className={classNames.input}
          type="email"
          value={email}
          placeholder={t.email}
          aria-label={t.email}
          onChange={e => setEmail(e.target.value)}
        />
        <button className={classNames.button} type="submit" disabled={state === 'saving' || !email.trim()}>
          {state === 'saving' ? t.adding : t.add}
        </button>
      </form>

      {error && (
        <p className={classNames.message} role="alert">
          {error}
        </p>
      )}

      {rows.length === 0 && state !== 'loading' ? (
        <p className={classNames.empty}>{t.empty}</p>
      ) : (
        <table className={classNames.table}>
          <tbody>
            {rows.map(r => (
              <tr className={classNames.row} key={r.email}>
                <td className={classNames.cell}>{r.email}</td>
                <td className={classNames.cell}>
                  <span className={classNames.source}>{r.source === 'manual' ? t.manual : t.synced}</span>
                </td>
                <td className={classNames.cell}>
                  <button
                    className={classNames.remove}
                    type="button"
                    onClick={() => remove(r.email)}
                    disabled={state === 'saving'}
                    aria-label={`${t.remove} ${r.email}`}
                  >
                    {t.remove}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
