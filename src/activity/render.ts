/**
 * Burst renderings for the Slack and Discord sinks (disky's thread model): a
 * parent line (who, counts, when), a details reply (pages, sessions), and one
 * reply per notify=`line` kind. Only notify=`line` events disclose detail.
 */
import type { ActivityBurst, ActivityLine } from './types.js'

export interface ActivityFmt {
  bold: (s: string) => string
  link: (url: string, text: string) => string
  code: (s: string) => string
  /** Literal text (a page path, a client's error message), escaped for the sink. */
  esc: (s: string) => string
}

/** Slack mrkdwn. `<`/`>`/`&` are escaped, so no text can form a link or a `<!channel>` mention. */
export const SLACK_FMT: ActivityFmt = {
  bold: s => `*${s}*`,
  link: (url, text) => `<${url.replace(/[<>|]/g, encodeURIComponent)}|${text.replace(/[<>|]/g, '')}>`,
  code: s => `\`${s.replace(/`/g, "'")}\``,
  esc: s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
}

/** Discord markdown; the sink also sends `allowed_mentions: { parse: [] }`. */
export const DISCORD_FMT: ActivityFmt = {
  bold: s => `**${s}**`,
  link: (url, text) => `[${text.replace(/[[\]]/g, '')}](<${url.replace(/[<>]/g, encodeURIComponent)}>)`,
  code: s => `\`${s.replace(/`/g, "'")}\``,
  esc: s => s.replace(/([*_~`|\\<>[\]])/g, '\\$1'),
}

/** Links the app can supply: a page line's URL, a session's viewer, the burst in the app's own admin UI. */
export interface ActivityLinks {
  eventHref?: (line: ActivityLine, burst: ActivityBurst) => string | null
  sessionHref?: (sessionId: string, burst: ActivityBurst) => string | null
  burstHref?: (burst: ActivityBurst) => string | null
}

/** A gap in seconds, at most two units: `45s`, `3m 07s`, `4h 17m`, `2d 03h`. */
export function fmtGap(s: number): string {
  const t = Math.max(0, Math.round(s))
  if (t < 60) return `${t}s`
  const m = Math.floor(t / 60)
  if (m < 60) return `${m}m ${String(t % 60).padStart(2, '0')}s`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ${String(m % 60).padStart(2, '0')}m`
  return `${Math.floor(h / 24)}d ${String(h % 24).padStart(2, '0')}h`
}

const NOUNS: Record<string, [string, string]> = {
  view: ['page load', 'page loads'],
  nav: ['URL change', 'URL changes'],
  click: ['click', 'clicks'],
  error: ['error', 'errors'],
  access: ['access event', 'access events'],
  resume: ['resumption', 'resumptions'],
}
const fmtN = (n: number): string => n.toLocaleString('en-US')
/** `3 page loads`; an app's own kind reads `kind: 3`. */
export const countText = (kind: string, n: number): string => {
  const noun = NOUNS[kind]
  return noun ? `${fmtN(n)} ${n === 1 ? noun[0] : noun[1]}` : `${kind}: ${fmtN(n)}`
}
const hm = (ts: number): string => new Date(ts * 1000).toISOString().slice(11, 16)
const day = (ts: number): string => new Date(ts * 1000).toISOString().slice(0, 10)
const span = (b: Pick<ActivityBurst, 'firstTs' | 'lastTs'>): string =>
  `${day(b.firstTs)} ${b.firstTs === b.lastTs ? hm(b.firstTs) : `${hm(b.firstTs)}–${hm(b.lastTs)}`}Z`
const via = (b: ActivityBurst): string => (b.actor.via === 'grant' ? 'share link' : b.actor.via)

const ORDER = Object.keys(NOUNS)
const rank = (kind: string): number => (ORDER.includes(kind) ? ORDER.indexOf(kind) : ORDER.length)
/** Kinds with notify≠off: the built-in kinds in a fixed order, then an app's own, alphabetically. */
const notified = (b: ActivityBurst): [string, number][] =>
  Object.entries(b.notifyCounts).filter(([, n]) => n > 0).sort(([x], [y]) => rank(x) - rank(y) || (x < y ? -1 : x > y ? 1 : 0))

export interface HeadlineOptions {
  fmt: ActivityFmt
  links?: ActivityLinks
  /** Posted as the actor (their name and face are the sender): leave out who, keep how for a link or service. */
  asActor?: boolean
}

/** The parent message: who (unless posted as them), the notified counts, when, and the burst link. */
export function renderHeadline(b: ActivityBurst, o: HeadlineOptions): string {
  const { fmt } = o
  const who = o.asActor ? (b.actor.via === 'sso' ? [] : [via(b)]) : [`${fmt.bold(fmt.esc(b.actor.name))} (${via(b)})`]
  const href = o.links?.burstHref?.(b)
  return [...who, ...notified(b).map(([k, n]) => countText(k, n)), span(b), ...(href ? [fmt.link(href, 'activity')] : [])].join(' · ')
}

/** Stops on a path trail, kept to the last this many. */
export const TRAIL_KEEP = 10
/** Sessions linked one by one, up to this many. */
export const MAX_SESSION_LINKS = 3

/** The details reply: the pages visited (view/nav lines, in order, repeats folded), the sessions, any omitted lines. Null when empty. */
export function renderDetails(b: ActivityBurst, o: { fmt: ActivityFmt; links?: ActivityLinks }): string | null {
  const { fmt } = o
  const out: string[] = []
  const stops: { line: ActivityLine; path: string; n: number }[] = []
  for (const line of b.lines) {
    if ((line.kind !== 'view' && line.kind !== 'nav') || !line.path) continue
    const prev = stops.at(-1)
    if (prev && prev.path === line.path) prev.n++
    else stops.push({ line, path: line.path, n: 1 })
  }
  if (stops.length) {
    const shown = stops.slice(-TRAIL_KEEP).map(({ line, path, n }) => {
      const href = o.links?.eventHref?.(line, b)
      return `${href ? fmt.link(href, path) : fmt.code(path)}${n > 1 ? ` ×${n}` : ''}`
    })
    const earlier = stops.length - shown.length
    out.push(`Pages${earlier ? ` (last ${shown.length} of ${stops.length})` : ''}: ${shown.join(' → ')}`)
  }
  const sessions = b.sessionIds
    .map(sid => [sid, o.links?.sessionHref?.(sid, b) ?? null] as const)
    .filter((x): x is readonly [string, string] => x[1] !== null)
  if (sessions.length) {
    out.push(sessions.length > MAX_SESSION_LINKS
      ? `${fmtN(sessions.length)} sessions: ${sessions.slice(-MAX_SESSION_LINKS).map(([sid, href]) => fmt.link(href, `session ${sid.slice(0, 8)}`)).join(' · ')}`
      : sessions.map(([sid, href]) => fmt.link(href, `session ${sid.slice(0, 8)}`)).join(' · '))
  }
  if (b.omittedLines) out.push(`${fmtN(b.omittedLines)} earlier recorded lines not shown`)
  return out.length ? out.join('\n') : null
}

/** Lines one reply lists, before `+N more`. */
export const MAX_LINES = 30

/**
 * One notify=`line` kind's reply: a header, then each distinct line (oldest first; repeats folded in as `×N`), its
 * time linked to its session, its page alongside. Null when the burst has none of that kind.
 */
export function renderKindLines(b: ActivityBurst, kind: string, o: { fmt: ActivityFmt; links?: ActivityLinks; max?: number }): string | null {
  const { fmt } = o
  const events = b.lines.filter(l => l.kind === kind && l.notify === 'line')
  if (!events.length) return null
  const groups = new Map<string, { first: ActivityLine; n: number }>()
  for (const e of events) {
    const key = `${e.line ?? ''}\u0000${e.path ?? ''}`
    const g = groups.get(key)
    if (g) g.n++
    else groups.set(key, { first: e, n: 1 })
  }
  const all = [...groups.values()]
  const max = o.max ?? MAX_LINES
  const item = ({ first: e, n }: { first: ActivityLine; n: number }) => {
    const session = e.sessionId ? o.links?.sessionHref?.(e.sessionId, b) : null
    const page = o.links?.eventHref?.(e, b)
    const text = e.line ?? e.path ?? kind
    const where = e.path && e.line && e.line !== e.path ? ` on ${page ? fmt.link(page, e.path) : fmt.code(e.path)}` : ''
    const body = e.line === e.path && page ? fmt.link(page, text) : fmt.esc(text)
    return `• ${session ? fmt.link(session, hm(e.ts)) : hm(e.ts)} ${body}${where}${n > 1 ? ` ×${fmtN(n)}` : ''}`
  }
  const out = [fmt.bold(countText(kind, b.notifyCounts[kind] ?? events.length)), ...all.slice(0, max).map(item)]
  if (all.length > max) out.push(`+${fmtN(all.length - max)} more`)
  return out.join('\n')
}

/** The notify=`line` kinds with lines in this burst, in first-seen order. */
export const lineKinds = (b: ActivityBurst): string[] => [...new Set(b.lines.filter(l => l.notify === 'line').map(l => l.kind))]

/** Cut to `max` characters, ending on a whole line where it can. */
export function bound(text: string, max: number): string {
  if (text.length <= max) return text
  const room = max - 2
  const cut = text.lastIndexOf('\n', room)
  return `${text.slice(0, cut > max / 2 ? cut : room)}\n…`
}

/** Discord's single message per burst: the headline, details and each line kind, cut to fit 2000 characters. */
export function renderDiscordMessage(b: ActivityBurst, links?: ActivityLinks): string {
  const o = { fmt: DISCORD_FMT, ...(links ? { links } : {}) }
  const parts = [renderHeadline(b, o), renderDetails(b, o), ...lineKinds(b).map(k => renderKindLines(b, k, o))].filter((p): p is string => !!p)
  return bound(parts.join('\n\n'), 2000)
}

/** Plain text, for an app's own logs or a sink without formatting. */
export function activityMessage(burst: ActivityBurst, max: number): string {
  const counts = Object.entries(burst.notifyCounts).map(([kind, n]) => `${kind}: ${n}`).join(', ')
  const lines = [
    `${burst.actor.name} (${burst.actor.via})`,
    `${new Date(burst.firstTs * 1000).toISOString()} - ${new Date(burst.lastTs * 1000).toISOString()}`,
    counts,
  ]
  for (const event of burst.lines) {
    if (event.notify !== 'line') continue
    lines.push(`[${event.kind}] ${event.line ?? event.path ?? event.kind}`)
  }
  if (burst.omittedLines) lines.push(`Earlier recorded lines omitted: ${burst.omittedLines}`)
  const text = lines.join('\n')
  return text.length <= max ? text : `${text.slice(0, max - 14)}\n[truncated]`
}
