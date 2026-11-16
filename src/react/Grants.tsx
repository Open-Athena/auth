import { type ComponentType, type FormEvent, type ReactNode, useEffect, useId, useRef, useState } from 'react'
import { shareKey } from '../client/api.js'
import { pseudonym } from '../client/identity.js'
import type { AuthClient } from '../client/api.js'
import type { GrantsController } from '../client/grants.js'
import type { Grant, MintInput } from '../core/http.js'
import { Avatar } from './Avatar.js'
import { AvatarField, type AvatarFieldProps } from './AvatarField.js'
import { useGrants, type UseGrantsResult } from './useGrants.js'

/** A scope an app offers on its links. `hint` is where to explain a consequence. */
export interface GrantScope {
  id: string
  label: ReactNode
  hint?: ReactNode
}

const DEFAULT_CLASSES = {
  panel: 'oa-ui oa-ui-grants',
  form: 'oa-ui-form',
  check: 'oa-ui-check',
  input: 'oa-ui-input',
  muted: 'oa-ui-muted',
  error: 'oa-ui-error',
  button: 'oa-ui-btn',
  primary: 'oa-ui-btn oa-ui-btn-primary',
  danger: 'oa-ui-btn oa-ui-btn-danger',
  linkish: 'oa-ui-linkish',
  list: 'oa-ui-list',
  card: 'oa-ui-card',
  cardRevoked: 'oa-ui-card oa-ui-card-revoked',
  cardHead: 'oa-ui-card-head',
  row: 'oa-ui-row',
  tag: 'oa-ui-tag',
  tagDead: 'oa-ui-tag oa-ui-tag-dead',
  facts: 'oa-ui-facts',
  holder: 'oa-ui-muted',
  holderForm: 'oa-ui-form',
  token: 'oa-ui-token',
  copyRow: 'oa-ui-copyrow',
  avatarField: '',
}

export type GrantsClassNames = Partial<typeof DEFAULT_CLASSES> & { avatar?: AvatarFieldProps['classNames'] }

const ago = (ts: number | null): string => {
  if (ts === null) return 'never'
  const s = Math.max(0, Math.floor(Date.now() / 1000) - ts)
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

/** One page a link opens: the same key works on any path the app serves. */
export interface GrantLinkEntry {
  label: string
  url: string
  /** The scope this page belongs to: `GrantCard` shows it on that scope's row rather than in the list below. */
  scope?: string
}

/** A link's URL, or one URL per page it opens (labeled), for a link with several scopes. */
export type GrantLinks = string | readonly GrantLinkEntry[]

/** Link shape is the app's: e.g. `(g, t) => shareUrl(t, `${origin}/${g.scopes[0]}/`)`, or one entry per scope. */
export type BuildGrantLink = (grant: Grant, token: string) => GrantLinks

/**
 * Keeps password managers (1Password, LastPass, Bitwarden) from offering to fill a field: these are a recipient's
 * details, never the admin's own, and `autoComplete="off"` doesn't stop them.
 */
export const NO_AUTOFILL = { autoComplete: 'off', 'data-1p-ignore': 'true', 'data-lpignore': 'true', 'data-bwignore': 'true' } as const

export interface GrantLinkProps {
  grant: Grant
  /** The token: just minted or rotated, or a kept one fetched again. Held only in the controller's memory. */
  token: string
  buildLink: BuildGrantLink
  /** Scopes whose entries are shown elsewhere (`GrantCard` puts them on the scope rows); "Copy all" still includes them. */
  omitScopes?: readonly string[]
  /** The key is kept, so these links can be shown again: say so instead of "copy this now". */
  kept?: boolean
  /** The gate's `keyParam` (the one new links use), for "Copy key". Default `key`. */
  keyParam?: string
  onDismiss?: () => void
  labels?: Partial<Record<'warning' | 'keptWarning' | 'copy' | 'copied' | 'copyAll' | 'copyKey' | 'copyFailed' | 'dismiss', ReactNode>>
  classNames?: GrantsClassNames
}

/** A link's entries, normalized: a bare string is one unlabeled entry. */
const linkEntries = (built: GrantLinks): { label: string | null; url: string; scope?: string }[] =>
  typeof built === 'string' ? [{ label: null, url: built }] : built.map(e => ({ ...e }))

/** Clipboard writes with a brief "Copied" on whichever button did it, and a failure flag. */
function useCopy() {
  const [state, setState] = useState<{ copied: string } | 'failed' | 'idle'>('idle')
  return {
    failed: state === 'failed',
    copied: (id: string) => typeof state === 'object' && state.copied === id,
    async copy(text: string, id: string) {
      const ok = await navigator.clipboard.writeText(text).then(() => true, () => false)
      setState(ok ? { copied: id } : 'failed')
      if (ok) setTimeout(() => setState(c => (typeof c === 'object' && c.copied === id ? 'idle' : c)), 1500)
    },
  }
}

/**
 * The moment a link exists outside its recipient's browser: show it (or one row per page it opens), offer a copy
 * of each, of all of them, and of just the key, and say it won't come back.
 */
export function GrantLink({ grant, token, buildLink, omitScopes = [], kept = false, keyParam = 'key', onDismiss, labels = {}, classNames }: GrantLinkProps) {
  const cx = { ...DEFAULT_CLASSES, ...classNames }
  const clip = useCopy()
  const all = linkEntries(buildLink(grant, token))
  const shown = all.filter(e => !(e.scope !== undefined && omitScopes.includes(e.scope)))
  const key = shareKey(token, keyParam)
  const copyLabel = (id: string, idle: ReactNode) => (clip.copied(id) ? (labels.copied ?? 'Copied') : idle)
  return (
    <div className={cx.token}>
      <p className={cx.muted}>
        {kept
          ? (labels.keptWarning ?? 'This key is kept (sealed), so these can be copied again later.')
          : (labels.warning ?? "Copy this now: only its hash is stored, so you won't see it again.")}
      </p>
      {shown.map(({ label, url }) => (
        <div key={url} className={cx.copyRow}>
          {label !== null && <span>{label}</span>}
          <input className={cx.input} readOnly value={url} aria-label={label ?? 'Share link'} onFocus={e => e.currentTarget.select()} />
          <button className={cx.button} type="button" onClick={() => void clip.copy(url, url)}>
            {copyLabel(url, labels.copy ?? 'Copy')}
          </button>
        </div>
      ))}
      <div className={cx.row}>
        <button className={cx.button} type="button" onClick={() => void clip.copy(key, 'key')}>
          {copyLabel('key', labels.copyKey ?? 'Copy key')}
        </button>
        {all.length > 1 && (
          <button
            className={cx.button}
            type="button"
            onClick={() => void clip.copy([...all.map(e => `${e.label}: ${e.url}`), `Key: ${key}`].join('\n'), 'all')}
          >
            {copyLabel('all', labels.copyAll ?? 'Copy all')}
          </button>
        )}
        {onDismiss && (
          <button className={cx.button} type="button" onClick={onDismiss}>
            {labels.dismiss ?? 'Done'}
          </button>
        )}
      </div>
      {clip.failed && (
        <p className={cx.error} role="alert">
          {labels.copyFailed ?? "Couldn't reach the clipboard. Select the link and copy it by hand."}
        </p>
      )}
    </div>
  )
}

/** One copy control's job: what it copies, and how to copy it. */
export interface CopyProps {
  kind: 'scope' | 'entry' | 'key' | 'all'
  /** What this control does, for its tooltip and accessible name ("Copy link"). */
  label: string
  /** What it copies, for display beside it where that isn't already shown ("All of them", "key", "all"). */
  name: string
  /**
   * Resolves the text to copy. It fetches the kept key on first use, which is logged. Call it from the click handler,
   * so the clipboard write keeps the user gesture.
   */
  text: () => Promise<string>
  /** Copy `text()` the library's way (`ClipboardItem` with a promise, falling back to `writeText`) and report how it went. */
  copy: () => Promise<'copied' | 'failed'>
}

/**
 * Copy text that may not be known yet. Safari only lets a clipboard write follow a click if it starts in the click
 * handler, so the write gets a `ClipboardItem` whose content is still a promise; where that isn't supported, the text
 * is awaited and written with `writeText`.
 */
export async function copyText(text: () => Promise<string>): Promise<'copied' | 'failed'> {
  const pending = text()
  pending.catch(() => {})
  const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard
  if (!clipboard) return 'failed'
  if (typeof ClipboardItem !== 'undefined' && typeof clipboard.write === 'function') {
    try {
      await clipboard.write([new ClipboardItem({ 'text/plain': pending.then(t => new Blob([t], { type: 'text/plain' })) })])
      return 'copied'
    } catch {
      // A browser without promised clipboard items, or a failed fetch: `writeText` settles which.
    }
  }
  try {
    await clipboard.writeText(await pending)
    return 'copied'
  } catch {
    return 'failed'
  }
}

const ClipboardGlyph = () => (
  <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5">
    <rect x="4" y="2.5" width="8" height="12" rx="1.5" />
    <path d="M6 2.5V1.75h4v.75" strokeLinecap="round" />
  </svg>
)

const CheckGlyph = () => (
  <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M3 8.5l3 3 7-7" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

/**
 * The default copy control: a clipboard icon that turns into a check for a moment once copied, with a tooltip saying
 * what it copies, and a short error if the clipboard refused.
 */
export function CopyIcon({ label, copy }: CopyProps) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const [tip, setTip] = useState(false)
  const tipId = useId()
  useEffect(() => {
    if (state === 'idle') return
    const timer = setTimeout(() => setState('idle'), state === 'copied' ? 1500 : 4000)
    return () => clearTimeout(timer)
  }, [state])
  return (
    <span className="oa-ui-copy">
      <button
        className="oa-ui-copy-btn"
        type="button"
        aria-label={label}
        aria-describedby={tip ? tipId : undefined}
        data-state={state}
        onClick={() => void copy().then(setState)}
        onMouseEnter={() => setTip(true)}
        onMouseLeave={() => setTip(false)}
        onFocus={() => setTip(true)}
        onBlur={() => setTip(false)}
      >
        {state === 'copied' ? <CheckGlyph /> : <ClipboardGlyph />}
      </button>
      {tip && (
        <span id={tipId} role="tooltip" className="oa-ui-tooltip">
          {state === 'copied' ? 'Copied' : label}
        </span>
      )}
      {state === 'failed' && (
        <span className="oa-ui-error" role="alert">
          Couldn't copy
        </span>
      )}
    </span>
  )
}

export interface ScopeLinkProps {
  grant: Grant
  scope: string
  entry: GrantLinkEntry
  Copy: ComponentType<CopyProps>
  copyProps: CopyProps
}

/** What sits after a scope's label while the card has a link for it: by default, just its copy control. */
export function DefaultScopeLink({ Copy, copyProps }: ScopeLinkProps) {
  return <Copy {...copyProps} />
}

export interface ExtraLinksProps {
  grant: Grant
  /** The entries not on a scope row. */
  entries: readonly GrantLinkEntry[]
  Copy: ComponentType<CopyProps>
  /** Ready-made props for each control, in display order: entries, then key, then all. */
  copies: readonly CopyProps[]
  /** Set only while a just-minted key that isn't kept is on screen: hides the icons. */
  onDismiss?: () => void
  /** The shown-once warning to put beside `onDismiss`'s "×". */
  warning?: ReactNode
}

/** The line under the scopes: each other page, the key and "all", as name + icon pairs. */
export function DefaultExtraLinks({ Copy, copies, onDismiss, warning }: ExtraLinksProps) {
  return (
    <>
      <p className="oa-ui-links">
        {copies.map((c, i) => (
          <span key={`${c.kind}-${i}`}>
            {i > 0 && ' · '}
            {c.name} <Copy {...c} />
          </span>
        ))}
      </p>
      {onDismiss && (
        <p className="oa-ui-muted">
          {warning}{' '}
          <button className="oa-ui-linkish" type="button" aria-label="Hide these links" onClick={onDismiss}>
            ×
          </button>
        </p>
      )}
    </>
  )
}

/** Swappable pieces of a card's links. Each falls back to the default; behavior (fetching, logging) stays the card's. */
export interface GrantLinkComponents {
  /** One copy control: a scope row's, a non-scope entry's, the key's, or "all"'s. */
  Copy?: ComponentType<CopyProps>
  /** What sits after a scope's label: by default `<Copy>` when the card has a link for that scope. */
  ScopeLink?: ComponentType<ScopeLinkProps>
  /** The line under the scopes: non-scope entries, the key and "all". */
  ExtraLinks?: ComponentType<ExtraLinksProps>
}

/** Stands in for the key when only a link's shape is wanted (which pages, which scopes), before the key is fetched. */
const SHAPE_KEY = 'KEY'

/**
 * The key a card copies its links with: the token in memory (just minted, rotated or revealed) when there is one,
 * else a kept key fetched on first use and held for the card's lifetime. Rotating or forgetting drops the held one.
 */
function useLinkKey(grant: Grant, grants: UseGrantsResult): { inMemory: string | null; key: () => Promise<string> } {
  const inMemory = grants.token?.grantId === grant.id ? grants.token.token : null
  const held = useRef<Promise<string> | null>(null)
  useEffect(() => {
    held.current = null
  }, [inMemory, grant.kept])
  const { fetchKey } = grants
  return {
    inMemory,
    key: () => {
      if (inMemory !== null) return Promise.resolve(inMemory)
      held.current ??= fetchKey(grant.id).catch(error => {
        held.current = null
        throw error
      })
      return held.current
    },
  }
}

const DAY_S = 86400

/** How the app's `WhoamiChip` shows an `anon` link to its recipient; picks the anon checkbox's default wording. */
export type AnonChipMode = 'label' | 'pseudonym' | 'hidden'

const ANON_COPY: Record<AnonChipMode, string> = {
  label: "Anonymous: the recipient doesn't see this name or photo",
  pseudonym: 'Anonymous: the recipient sees a made-up name, not this name or photo',
  hidden: 'Anonymous: the recipient sees no name, photo or account menu',
}

export interface GrantMintFormProps {
  /** Rendered as checkboxes; at least one must be chosen. A lone scope starts checked. */
  scopes: readonly GrantScope[]
  /** Resolve truthy once the link exists, which resets the form; falsy keeps what was typed. */
  onMint: (input: MintInput) => Promise<unknown>
  busy?: boolean
  error?: string | null
  /** A starting memo, re-evaluated for each new link. */
  defaultMemo?: string | (() => string)
  /** Offered expiries, in days; 0 is "never". */
  expiryDays?: readonly number[]
  defaultExpiryDays?: number
  /** Offered redemption caps; 0 is "unlimited". */
  maxRedeems?: readonly number[]
  /** Offer "also let this email sign in" (needs an `allowlist` store on the routes). */
  allowlist?: boolean
  /** The `<basePath>/avatar` route, to offer choosing the holder's face. */
  avatarEndpoint?: string
  /** Match the app's `<WhoamiChip anon=…>`, so the anon checkbox says what the recipient will see. Default `label`. */
  anonChip?: AnonChipMode
  /**
   * Keep each new link's key, sealed, so staff can copy it again later (`Grant.kept`); a checkbox offers the other
   * choice. Default false: a key is shown once.
   */
  keepTokens?: boolean
  labels?: Partial<
    Record<
      | 'keepKey' | 'forgetKey'
      | 'memo' | 'holder' | 'email' | 'allowlist' | 'avatar' | 'scopes' | 'expires' | 'never' | 'maxRedeems' | 'unlimited' | 'submit' | 'submitting' | 'scopeRequired'
      | 'anon' | 'service',
      ReactNode
    >
  >
  classNames?: GrantsClassNames
}

const resolveMemo = (memo: GrantMintFormProps['defaultMemo']) => (typeof memo === 'function' ? memo() : (memo ?? ''))

export function GrantMintForm({
  scopes,
  onMint,
  busy = false,
  error,
  defaultMemo,
  expiryDays = [0, 1, 7, 30],
  defaultExpiryDays = 30,
  maxRedeems = [0, 1, 3],
  allowlist = false,
  avatarEndpoint,
  anonChip = 'label',
  keepTokens = false,
  labels = {},
  classNames,
}: GrantMintFormProps) {
  const cx = { ...DEFAULT_CLASSES, ...classNames }
  const [memo, setMemo] = useState(() => resolveMemo(defaultMemo))
  const [holder, setHolder] = useState('')
  const [email, setEmail] = useState('')
  const [allow, setAllow] = useState(true)
  const [avatar, setAvatar] = useState<string | null>(null)
  const [chosen, setChosen] = useState<ReadonlySet<string>>(() => new Set(scopes.length === 1 ? [scopes[0]!.id] : []))
  const [days, setDays] = useState(defaultExpiryDays)
  const [max, setMax] = useState(0)
  const [noScope, setNoScope] = useState(false)
  const [anon, setAnon] = useState(false)
  /** The non-default choice: forget (when keys are kept by default) or keep (when they aren't). */
  const [otherKeep, setOtherKeep] = useState(false)
  const [service, setService] = useState(false)

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    // In the order offered, whatever order they were clicked in: a hub's link
    // shape depends on the first scope.
    const picked = scopes.filter(s => chosen.has(s.id)).map(s => s.id)
    if (!picked.length) {
      setNoScope(true)
      return
    }
    setNoScope(false)
    const name = holder.trim()
    // A service link is never a person's, so it takes no email (the server refuses both).
    const address = service ? '' : email.trim()
    const input: MintInput = {
      name: memo.trim() || null,
      ...(name ? { subjectName: name } : {}),
      email: address || null,
      ...(allowlist && address ? { allowlist: allow } : {}),
      ...(avatarEndpoint ? { avatar } : {}),
      scopes: picked,
      maxRedeems: max > 0 ? max : null,
      expiresInS: days > 0 ? days * DAY_S : null,
      ...(anon ? { anon: true } : {}),
      ...(service ? { service: true } : {}),
      keepToken: keepTokens !== otherKeep,
    }
    if (await onMint(input)) {
      setMemo(resolveMemo(defaultMemo))
      setHolder('')
      setEmail('')
      setAvatar(null)
      setAnon(false)
      setService(false)
      setOtherKeep(false)
    }
  }

  return (
    <form className={cx.form} onSubmit={submit}>
      <label>
        <span>{labels.memo ?? 'Memo'}</span>
        <input className={cx.input} name="memo" value={memo} onChange={e => setMemo(e.target.value)} {...NO_AUTOFILL} placeholder="private: never shown to the recipient" />
      </label>
      <label>
        <span>{labels.holder ?? 'Holder'}</span>
        <input className={cx.input} name="holder" value={holder} onChange={e => setHolder(e.target.value)} {...NO_AUTOFILL} />
      </label>
      <label>
        <span>{labels.email ?? 'Email'}</span>
        <input className={cx.input} name="email" type="email" value={service ? '' : email} disabled={service} onChange={e => setEmail(e.target.value)} {...NO_AUTOFILL} />
      </label>
      {allowlist && !service && (
        <label className={cx.check}>
          <input type="checkbox" checked={allow} onChange={e => setAllow(e.target.checked)} />
          <span>{labels.allowlist ?? 'Also let this email sign in'}</span>
        </label>
      )}
      {avatarEndpoint && (
        <div className={cx.avatarField}>
          <label htmlFor="oa-grant-avatar">{labels.avatar ?? 'Face'}</label>
          <AvatarField
            id="oa-grant-avatar"
            endpoint={avatarEndpoint}
            value={avatar}
            onChange={setAvatar}
            email={email}
            name={holder.trim() || null}
            size={36}
            {...(classNames?.avatar ? { classNames: classNames.avatar } : {})}
          />
        </div>
      )}
      <label className={cx.check}>
        <input type="checkbox" name="anon" checked={anon} onChange={e => setAnon(e.target.checked)} />
        <span>{labels.anon ?? ANON_COPY[anonChip]}</span>
      </label>
      <label className={cx.check}>
        <input type="checkbox" name="service" checked={service} onChange={e => setService(e.target.checked)} />
        <span>{labels.service ?? 'Service account: for a job, not a person (no email)'}</span>
      </label>
      <label className={cx.check}>
        <input type="checkbox" name="keep" checked={otherKeep} onChange={e => setOtherKeep(e.target.checked)} />
        <span>
          {keepTokens
            ? (labels.forgetKey ?? "Forget the key after this (it's shown only once)")
            : (labels.keepKey ?? 'Keep the key (sealed), so staff can copy this link again')}
        </span>
      </label>
      <fieldset>
        <legend>{labels.scopes ?? 'Opens'}</legend>
        {scopes.map(scope => (
          <label key={scope.id} className={cx.check}>
            <input
              type="checkbox"
              checked={chosen.has(scope.id)}
              onChange={e => {
                const next = new Set(chosen)
                if (e.target.checked) next.add(scope.id)
                else next.delete(scope.id)
                setChosen(next)
                setNoScope(false)
              }}
            />
            <span>
              {scope.label}
              {scope.hint !== undefined && <span className={cx.muted}> {scope.hint}</span>}
            </span>
          </label>
        ))}
      </fieldset>
      <label>
        <span>{labels.expires ?? 'Expires in'}</span>
        <select className={cx.input} value={days} onChange={e => setDays(Number(e.target.value))}>
          {expiryDays.map(d => (
            <option key={d} value={d}>
              {d === 0 ? (labels.never ?? 'never') : d === 1 ? '1 day' : `${d} days`}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>{labels.maxRedeems ?? 'Max redemptions'}</span>
        <select className={cx.input} value={max} onChange={e => setMax(Number(e.target.value))}>
          {maxRedeems.map(n => (
            <option key={n} value={n}>
              {n === 0 ? (labels.unlimited ?? 'unlimited') : n}
            </option>
          ))}
        </select>
      </label>
      <button className={cx.primary} type="submit" disabled={busy}>
        {busy ? (labels.submitting ?? 'Minting…') : (labels.submit ?? 'Mint link')}
      </button>
      {noScope && (
        <p className={cx.error} role="alert">
          {labels.scopeRequired ?? 'Choose at least one.'}
        </p>
      )}
      {error && (
        <p className={cx.error} role="alert">
          {error}
        </p>
      )}
    </form>
  )
}

/** Rotate and revoke can't be taken back, so each takes a second, deliberate click. */
function ConfirmButton({
  className,
  disabled,
  label,
  confirm,
  onConfirm,
}: {
  className: string
  disabled: boolean
  label: ReactNode
  confirm: ReactNode
  onConfirm: () => void
}) {
  const [armed, setArmed] = useState(false)
  return (
    <button
      className={className}
      type="button"
      disabled={disabled}
      onBlur={() => setArmed(false)}
      onClick={() => {
        if (armed) onConfirm()
        setArmed(!armed)
      }}
    >
      {armed ? confirm : label}
    </button>
  )
}

/** The offered scopes, then any on the link no longer offered. The last one checked can't be unchecked. */
function ScopeChecks({ grant, grants, scopes, busy, className, link }: {
  grant: Grant
  grants: UseGrantsResult
  scopes: readonly GrantScope[]
  busy: boolean
  className: string
  /** The scope's own copy control while the card has links, if it has one. */
  link: (id: string) => ReactNode
}) {
  const listed = [...scopes.map(s => s.id), ...grant.scopes.filter(id => !scopes.some(s => s.id === id))]
  return (
    <>
      {listed.map(id => {
        const on = grant.scopes.includes(id)
        return (
          <label key={id} className={className}>
            <input
              type="checkbox"
              checked={on}
              disabled={busy || (on && grant.scopes.length === 1)}
              onChange={() => void grants.update(grant.id, { scopes: listed.filter(s => (s === id ? !on : grant.scopes.includes(s))) })}
            />
            <span>{scopes.find(s => s.id === id)?.label ?? id}</span>
            {on && link(id)}
          </label>
        )
      })}
    </>
  )
}

/** A link whose key isn't kept: the shown-once note, and a way to keep it by pasting the key (links already sent keep working). */
function KeepExisting({ grant, grants, busy, labels, cx }: {
  grant: Grant
  grants: UseGrantsResult
  busy: boolean
  labels: NonNullable<GrantCardProps['labels']>
  cx: typeof DEFAULT_CLASSES
}) {
  const [open, setOpen] = useState(false)
  const [key, setKey] = useState('')
  return (
    <>
      <p className={cx.muted}>
        {labels.lostToken ?? 'Link shown once at mint. Rotate it for a fresh one if you lost it.'}{' '}
        {!open && (
          <button className={cx.linkish} type="button" onClick={() => setOpen(true)}>
            {labels.keepExisting ?? "keep this link's key"}
          </button>
        )}
      </p>
      {open && (
        <form
          className={cx.row}
          onSubmit={async e => {
            e.preventDefault()
            if (await grants.keepToken(grant.id, key.trim())) {
              setKey('')
              setOpen(false)
            }
          }}
        >
          <input
            className={cx.input}
            name="key"
            value={key}
            onChange={e => setKey(e.target.value)}
            placeholder={typeof labels.keepExistingHint === 'string' ? labels.keepExistingHint : 'its key, or the whole link'}
            aria-label="This link's key"
            {...NO_AUTOFILL}
          />
          <button className={cx.button} type="submit" disabled={busy || !key.trim()}>
            {labels.keepExistingSave ?? 'Keep'}
          </button>
          <button className={cx.button} type="button" onClick={() => setOpen(false)}>
            {labels.cancel ?? 'Cancel'}
          </button>
        </form>
      )}
    </>
  )
}

export interface GrantCardProps {
  grant: Grant
  grants: UseGrantsResult
  /** To label this link's scopes; an id no longer offered shows as itself. */
  scopes?: readonly GrantScope[]
  /**
   * A checkbox per scope, saved on each click, for adding or removing one on a
   * link already sent. Sessions already redeemed follow on their next request.
   * A scope no longer offered stays listed, so a save can't drop it unnoticed.
   */
  editScopes?: boolean
  buildLink: BuildGrantLink
  allowlist?: boolean
  avatarEndpoint?: string
  /** After the holder is edited: binding an email may have added an allowlist row. */
  onHolderSaved?: () => void
  /** See `GrantMintFormProps.anonChip`. */
  anonChip?: AnonChipMode
  /** See `GrantLinkProps.keyParam`. */
  keyParam?: string
  /** Replacements for the copy controls and where they sit (`GrantLinkComponents`); each defaults to the built-in. */
  components?: GrantLinkComponents
  labels?: GrantLinkProps['labels'] &
    Partial<
      Record<
        | 'noMemo' | 'revoked' | 'expired' | 'disabled' | 'disabledNote' | 'enable' | 'disable' | 'rotate' | 'rotateConfirm' | 'revoke' | 'revokeConfirm'
        | 'lostToken' | 'someone' | 'edit' | 'save' | 'cancel' | 'holderName' | 'holderEmail' | 'allowlist' | 'face' | 'widelyOpened' | 'allowlistKeepsScopes'
        | 'anon' | 'service' | 'anonToggle' | 'serviceToggle'
        | 'copyLink' | 'keyName' | 'allName' | 'keptNote' | 'forgetKept' | 'forgetKeptConfirm' | 'keepExisting' | 'keepExistingHint' | 'keepExistingSave',
        ReactNode
      >
    >
  classNames?: GrantsClassNames
}

/** One link: its status, scopes, holder, activity, and the verbs that change it. */
export function GrantCard({ grant, grants, scopes = [], editScopes = false, buildLink, allowlist = false, avatarEndpoint, onHolderSaved, anonChip = 'label', keyParam = 'key', components = {}, labels = {}, classNames }: GrantCardProps) {
  const cx = { ...DEFAULT_CLASSES, ...classNames }
  const [editing, setEditing] = useState(false)
  const { activity: loadActivity } = grants
  const activity = grants.activities[grant.id]
  // Re-read when use of the link is seen, rather than once per link per poll.
  useEffect(() => {
    void loadActivity(grant.id)
  }, [loadActivity, grant.id, grant.lastUsedAt, grant.redeems])

  const busy = grants.pending[grant.id] !== undefined
  const revoked = grant.revokedAt !== null
  const disabled = grant.disabledAt !== null
  const expired = grant.expiresAt !== null && grant.expiresAt * 1000 < Date.now()
  const { inMemory, key } = useLinkKey(grant, grants)
  // Links can be copied while a key is in memory or kept (fetched on the first copy).
  const linked = !revoked && (inMemory !== null || grant.kept)
  const Copy = components.Copy ?? CopyIcon
  const ScopeLinkSlot = components.ScopeLink ?? DefaultScopeLink
  const ExtraLinksSlot = components.ExtraLinks ?? DefaultExtraLinks
  const str = (label: ReactNode, fallback: string) => (typeof label === 'string' ? label : fallback)
  const copyProps = (kind: CopyProps['kind'], name: string, text: () => Promise<string>): CopyProps => ({
    kind,
    name,
    label: kind === 'key' ? str(labels.copyKey, 'Copy key') : kind === 'all' ? str(labels.copyAll, 'Copy all') : str(labels.copyLink, 'Copy link'),
    text,
    copy: () => copyText(text),
  })
  // The link's shape (which pages, which scopes), re-read on every render so a scope checked while links show gets its
  // icon and an unchecked one loses it. The key itself is only resolved by a copy.
  const shape: GrantLinkEntry[] = (linked ? linkEntries(buildLink(grant, inMemory ?? SHAPE_KEY)) : []).map(e => ({ ...e, label: e.label ?? 'link' }))
  const urlAt = (i: number) => async () => linkEntries(buildLink(grant, await key()))[i]!.url
  const scoped = new Map<string, { entry: GrantLinkEntry; copy: CopyProps }>()
  shape.forEach((entry, i) => {
    if (entry.scope !== undefined && grant.scopes.includes(entry.scope)) scoped.set(entry.scope, { entry, copy: copyProps('scope', entry.label, urlAt(i)) })
  })
  const extras = shape.flatMap((entry, i) => (entry.scope !== undefined && scoped.has(entry.scope) ? [] : [{ entry, i }]))
  const copies = [
    ...extras.map(({ entry, i }) => copyProps('entry', entry.label, urlAt(i))),
    copyProps('key', str(labels.keyName, 'key'), async () => shareKey(await key(), keyParam)),
    ...(shape.length > 1
      ? [copyProps('all', str(labels.allName, 'all'), async () => {
          const token = await key()
          return [...linkEntries(buildLink(grant, token)).map(e => `${e.label}: ${e.url}`), `Key: ${shareKey(token, keyParam)}`].join('\n')
        })]
      : []),
  ]
  const scopeLink = (id: string) => {
    const link = scoped.get(id)
    return link ? <ScopeLinkSlot grant={grant} scope={id} entry={link.entry} Copy={Copy} copyProps={link.copy} /> : null
  }
  const holder = grant.subject?.name || grant.subject?.email || grant.email
  // 1–3 redemptions is one person on their phone, laptop and work machine. Many
  // more, especially across countries, is the forwarding signal: a soft badge,
  // deliberately not an alarm.
  const spread = (activity?.distinctIps ?? 0) > 3 || (activity?.countries.length ?? 0) > 2
  const failed = grants.error?.grantId === grant.id && grants.error.action !== 'activity' ? grants.error.message : null

  return (
    <article className={revoked ? cx.cardRevoked : cx.card} data-grant={grant.id}>
      <header className={cx.cardHead}>
        <h3>
          {grant.name ?? labels.noMemo ?? 'No memo'}
          {grant.anon && <> <span className={cx.tag} title={pseudonym(grant.id)}>{labels.anon ?? 'anon'}</span></>}
          {grant.service && <> <span className={cx.tag}>{labels.service ?? 'service'}</span></>}
        </h3>
        {revoked ? (
          <span className={cx.tagDead}>{labels.revoked ?? 'revoked'}</span>
        ) : expired ? (
          <span className={cx.tagDead}>{labels.expired ?? 'expired'}</span>
        ) : (
          <div className={cx.row}>
            {disabled ? (
              <button className={cx.button} type="button" disabled={busy} onClick={() => void grants.enable(grant.id)}>
                {labels.enable ?? 'Enable'}
              </button>
            ) : (
              <button className={cx.button} type="button" disabled={busy} onClick={() => void grants.disable(grant.id)}>
                {labels.disable ?? 'Disable'}
              </button>
            )}
            <ConfirmButton
              className={cx.button}
              disabled={busy}
              label={labels.rotate ?? 'Rotate'}
              confirm={labels.rotateConfirm ?? 'Kill the old link?'}
              onConfirm={() => void grants.rotate(grant.id)}
            />
            <ConfirmButton
              className={cx.danger}
              disabled={busy}
              label={labels.revoke ?? 'Revoke'}
              confirm={labels.revokeConfirm ?? 'End every session?'}
              onConfirm={() => void grants.revoke(grant.id)}
            />
          </div>
        )}
      </header>

      {disabled && !revoked && (
        <p className={cx.muted}>
          <span className={cx.tag}>{labels.disabled ?? 'disabled'}</span>{' '}
          {labels.disabledNote ?? 'No new redemptions; anyone already in stays in.'}
        </p>
      )}

      {editing ? (
        <HolderEditor
          grant={grant}
          grants={grants}
          allowlist={allowlist}
          avatarEndpoint={avatarEndpoint}
          labels={labels}
          classNames={classNames}
          onDone={() => setEditing(false)}
          {...(onHolderSaved ? { onSaved: onHolderSaved } : {})}
        />
      ) : (
        (grant.subject || !revoked) && (
          <p className={cx.holder}>
            {grant.subject?.avatar && <Avatar src={grant.subject.avatar} name={holder} size={20} />} for {holder ?? labels.someone ?? 'someone'}
            {!revoked && (
              <>
                {' '}
                <button className={cx.linkish} type="button" onClick={() => setEditing(true)}>
                  {labels.edit ?? 'edit'}
                </button>
              </>
            )}
          </p>
        )
      )}

      <dl className={cx.facts}>
        <div>
          <dt>scopes</dt>
          <dd>
            {editScopes && !revoked ? (
              <ScopeChecks grant={grant} grants={grants} scopes={scopes} busy={busy} className={cx.check} link={scopeLink} />
            ) : scoped.size ? (
              grant.scopes.map(id => {
                const label = scopes.find(s => s.id === id)?.label ?? id
                return (
                  <div key={id} className={cx.check}>
                    <span>{label}</span> {scopeLink(id)}
                  </div>
                )
              })
            ) : (
              grant.scopes.map((id, i) => (
                <span key={id}>
                  {i > 0 && ', '}
                  {scopes.find(s => s.id === id)?.label ?? id}
                </span>
              ))
            )}
          </dd>
        </div>
        <div>
          <dt>redemptions</dt>
          <dd>
            {/* Older redemptions by preview bots, read as previews (the row's count is left as it was). */}
            {Math.max(0, grant.redeems - (activity?.botRedeems ?? 0))}
            {grant.maxRedeems !== null && ` / ${grant.maxRedeems}`}
          </dd>
        </div>
        {(activity?.staffClicks.length ?? 0) > 0 && (
          <div>
            <dt>opened by staff</dt>
            <dd>{activity!.staffClicks.join(', ')}</dd>
          </div>
        )}
        {(activity?.previews ?? 0) > 0 && (
          <div>
            <dt>previews</dt>
            <dd>
              {activity!.previews} ({activity!.previewBots.join(', ')})
            </dd>
          </div>
        )}
        <div>
          <dt>views</dt>
          <dd>{activity?.views ?? 0}</dd>
        </div>
        <div>
          <dt>distinct clients</dt>
          <dd>
            {activity?.distinctIps ?? 0} {spread && <span className={cx.tag}>{labels.widelyOpened ?? 'widely opened'}</span>}
          </dd>
        </div>
        <div>
          <dt>last seen</dt>
          <dd>{ago(grant.lastUsedAt)}</dd>
        </div>
        <div>
          <dt>expires</dt>
          <dd>{grant.expiresAt === null ? 'never' : new Date(grant.expiresAt * 1000).toLocaleDateString()}</dd>
        </div>
      </dl>

      {linked && (
        <ExtraLinksSlot
          grant={grant}
          entries={extras.map(e => e.entry)}
          Copy={Copy}
          copies={copies}
          {...(inMemory !== null && !grant.kept
            ? { onDismiss: grants.dismissToken, warning: labels.warning ?? "Copy these now: only the key's hash is stored, so they won't show again." }
            : {})}
        />
      )}

      {!revoked && (
        <div className={cx.row}>
          <label className={cx.check}>
            <input type="checkbox" name="anon" checked={grant.anon} disabled={busy} onChange={() => void grants.update(grant.id, { anon: !grant.anon })} />
            <span>{labels.anonToggle ?? ANON_COPY[anonChip]}</span>
          </label>
          <label className={cx.check}>
            <input
              type="checkbox"
              name="service"
              checked={grant.service}
              // A link bound to an email is a person's; unbind it first.
              disabled={busy || (!grant.service && grant.email !== null)}
              onChange={() => void grants.update(grant.id, { service: !grant.service })}
            />
            <span>{labels.serviceToggle ?? 'Service account'}</span>
          </label>
        </div>
      )}

      {editScopes && allowlist && !revoked && grant.email && (
        <p className={cx.muted}>{labels.allowlistKeepsScopes ?? `This doesn't change what ${grant.email} gets by signing in, if they're on the allowlist.`}</p>
      )}

      {activity && activity.topPaths.length > 0 && (
        <p className={cx.muted}>
          mostly {activity.topPaths.map(p => `${p.path} (${p.views})`).join(', ')}
          {activity.countries.length > 0 && ` · from ${activity.countries.join(', ')}`}
        </p>
      )}

      {failed && (
        <p className={cx.error} role="alert">
          {failed}
        </p>
      )}

      {revoked ? null : grant.kept ? (
        <div className={cx.row}>
          <span className={cx.muted}>{labels.keptNote ?? 'Its key is kept, sealed; each fetch is logged.'}</span>
          <ConfirmButton
            className={cx.linkish}
            disabled={busy}
            label={labels.forgetKept ?? 'forget key'}
            confirm={labels.forgetKeptConfirm ?? 'Only rotating brings it back. Forget?'}
            onConfirm={() => void grants.forgetToken(grant.id)}
          />
        </div>
      ) : inMemory === null ? (
        <KeepExisting grant={grant} grants={grants} busy={busy} labels={labels} cx={cx} />
      ) : null}
    </article>
  )
}

/**
 * Rename the link's holder or change their face after minting; a link minted
 * without an email can be given one, and the holder's existing session becomes
 * theirs with no new link to send.
 */
function HolderEditor({
  grant,
  grants,
  allowlist,
  avatarEndpoint,
  labels,
  classNames,
  onDone,
  onSaved,
}: Pick<GrantCardProps, 'grant' | 'grants' | 'allowlist' | 'avatarEndpoint' | 'labels' | 'classNames'> & { onDone: () => void; onSaved?: () => void }) {
  const cx = { ...DEFAULT_CLASSES, ...classNames }
  const l = labels ?? {}
  const [name, setName] = useState(grant.subject?.name ?? '')
  // `undefined` = keep the current face; `null` = clear it; a `data:` URI = replace.
  const [avatar, setAvatar] = useState<string | null | undefined>(undefined)
  const [email, setEmail] = useState('')
  const [allow, setAllow] = useState(true)
  const bind = grant.email === null && !grant.service && email.trim() !== ''
  return (
    <form
      className={cx.holderForm}
      onSubmit={async e => {
        e.preventDefault()
        const ok = await grants.update(grant.id, {
          subjectName: name,
          ...(avatar === undefined ? {} : { avatar }),
          ...(bind ? { email: email.trim(), ...(allowlist ? { allowlist: allow } : {}) } : {}),
        })
        if (ok) {
          onSaved?.()
          onDone()
        }
      }}
    >
      <label>
        <span>{l.holderName ?? "Holder's name"}</span>
        <input className={cx.input} type="text" value={name} onChange={e => setName(e.target.value)} autoFocus {...NO_AUTOFILL} />
      </label>
      {grant.email === null && !grant.service && (
        <label>
          <span>{l.holderEmail ?? 'Their email'}</span>
          <input className={cx.input} type="email" value={email} placeholder="optional" onChange={e => setEmail(e.target.value)} {...NO_AUTOFILL} />
        </label>
      )}
      {bind && allowlist && (
        <label className={cx.check}>
          <input type="checkbox" checked={allow} onChange={e => setAllow(e.target.checked)} />
          <span>{l.allowlist ?? 'Also let this email sign in'}</span>
        </label>
      )}
      {avatarEndpoint && (
        <div className={cx.avatarField}>
          <span>{l.face ?? 'Face'}</span>
          <AvatarField
            id={`oa-holder-avatar-${grant.id}`}
            endpoint={avatarEndpoint}
            value={avatar === undefined ? (grant.subject?.avatar ?? null) : avatar}
            onChange={setAvatar}
            email={grant.email}
            autoGravatar={false}
            name={name.trim() || null}
            size={36}
            {...(classNames?.avatar ? { classNames: classNames.avatar } : {})}
          />
        </div>
      )}
      <div className={cx.row}>
        <button className={cx.button} type="submit" disabled={grants.pending[grant.id] !== undefined}>
          {l.save ?? 'Save'}
        </button>
        <button className={cx.button} type="button" onClick={onDone}>
          {l.cancel ?? 'Cancel'}
        </button>
      </div>
    </form>
  )
}

export type GrantsPanelProps = ({ client: AuthClient; controller?: undefined } | { controller: GrantsController; client?: undefined }) &
  Pick<GrantMintFormProps, 'scopes' | 'defaultMemo' | 'expiryDays' | 'defaultExpiryDays' | 'maxRedeems' | 'allowlist' | 'avatarEndpoint' | 'anonChip' | 'keepTokens'> & {
    buildLink: BuildGrantLink
    /** Re-read the list this often. Off by default. */
    pollMs?: number
    /** A new link. Its token stays in the panel, not here. */
    onMinted?: (grant: Grant) => void
    /** After a link is minted or its holder edited: anything derived from the allowlist should look again. */
    onChanged?: () => void
    /** Before the form and before the list, e.g. what these links do in your app. */
    mintIntro?: ReactNode
    listIntro?: ReactNode
    mintHeading?: ReactNode
    listHeading?: ReactNode
    emptyLabel?: ReactNode
    labels?: GrantMintFormProps['labels']
    cardLabels?: GrantCardProps['labels']
    /** Scope checkboxes on each link: see `GrantCard`. */
    editScopes?: boolean
    /** See `GrantLinkProps.keyParam`. */
    keyParam?: string
    /** Passed to each card: see `GrantCardProps.components`. */
    components?: GrantLinkComponents
    classNames?: GrantsClassNames & { section?: string }
  }

/** A mint form over the list of links, composed from the exported parts. */
export function GrantsPanel({
  client,
  controller,
  scopes,
  buildLink,
  pollMs,
  onMinted,
  onChanged,
  mintIntro,
  listIntro,
  mintHeading = 'Mint a share link',
  listHeading = 'Share links',
  emptyLabel = 'None yet.',
  labels,
  cardLabels,
  editScopes = false,
  keyParam,
  components,
  classNames,
  defaultMemo,
  expiryDays,
  defaultExpiryDays,
  maxRedeems,
  allowlist,
  avatarEndpoint,
  anonChip,
  keepTokens,
}: GrantsPanelProps) {
  const cx = { ...DEFAULT_CLASSES, ...classNames }
  const grants = useGrants(controller ? { controller, pollMs } : { client: client!, pollMs })
  const listFailed = grants.error?.action === 'refresh' ? grants.error.message : null
  return (
    <div className={cx.panel}>
      <section className={classNames?.section}>
        <h2>{mintHeading}</h2>
        {mintIntro}
        <GrantMintForm
          scopes={scopes}
          busy={grants.minting}
          error={grants.error?.action === 'mint' ? grants.error.message : null}
          onMint={async input => {
            const grant = await grants.mint(input)
            if (grant) {
              onMinted?.(grant)
              onChanged?.()
            }
            return grant
          }}
          labels={labels}
          classNames={classNames}
          {...(defaultMemo === undefined ? {} : { defaultMemo })}
          {...(expiryDays === undefined ? {} : { expiryDays })}
          {...(defaultExpiryDays === undefined ? {} : { defaultExpiryDays })}
          {...(maxRedeems === undefined ? {} : { maxRedeems })}
          {...(allowlist === undefined ? {} : { allowlist })}
          {...(avatarEndpoint === undefined ? {} : { avatarEndpoint })}
          {...(anonChip === undefined ? {} : { anonChip })}
          {...(keepTokens === undefined ? {} : { keepTokens })}
        />
      </section>
      <section className={classNames?.section}>
        <h2>{listHeading}</h2>
        {listIntro}
        {listFailed && (
          <p className={cx.error} role="alert">
            {listFailed}
          </p>
        )}
        {!grants.loaded && grants.loading && <p className={cx.muted}>Loading…</p>}
        {grants.loaded && grants.grants.length === 0 && <p className={cx.muted}>{emptyLabel}</p>}
        <div className={cx.list}>
          {grants.grants.map(grant => (
            <GrantCard
              key={grant.id}
              grant={grant}
              grants={grants}
              scopes={scopes}
              editScopes={editScopes}
              buildLink={buildLink}
              allowlist={allowlist ?? false}
              labels={cardLabels}
              classNames={classNames}
              {...(onChanged ? { onHolderSaved: onChanged } : {})}
              {...(avatarEndpoint === undefined ? {} : { avatarEndpoint })}
              {...(anonChip === undefined ? {} : { anonChip })}
              {...(keyParam === undefined ? {} : { keyParam })}
              {...(components === undefined ? {} : { components })}
            />
          ))}
        </div>
      </section>
    </div>
  )
}
