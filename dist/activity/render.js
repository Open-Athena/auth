/** Slack mrkdwn. `<`/`>`/`&` are escaped, so no text can form a link or a `<!channel>` mention. */
export const SLACK_FMT = {
    bold: s => `*${s}*`,
    link: (url, text) => `<${url.replace(/[<>|]/g, encodeURIComponent)}|${text.replace(/[<>|]/g, '').replace(/&/g, '&amp;')}>`,
    code: s => `\`${s.replace(/`/g, "'")}\``,
    esc: s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
};
/** Discord markdown; the sink also sends `allowed_mentions: { parse: [] }`. */
export const DISCORD_FMT = {
    bold: s => `**${s}**`,
    link: (url, text) => `[${text.replace(/[[\]]/g, '')}](<${url.replace(/[<>]/g, encodeURIComponent)}>)`,
    code: s => `\`${s.replace(/`/g, "'")}\``,
    esc: s => s.replace(/([*_~`|\\<>[\]])/g, '\\$1'),
};
/** Refuses a zone the runtime doesn't know, at sink construction rather than at the first send. */
export function checkTimeZone(timeZone) {
    if (timeZone !== undefined)
        new Intl.DateTimeFormat('en-US', { timeZone });
}
const UTC_CLOCK = {
    hm: ts => new Date(ts * 1000).toISOString().slice(11, 16),
    day: ts => new Date(ts * 1000).toISOString().slice(0, 10),
    zone: () => 'Z',
};
const clocks = new Map();
function clockFor(timeZone) {
    if (timeZone === undefined || timeZone === 'UTC')
        return UTC_CLOCK;
    let clock = clocks.get(timeZone);
    if (!clock) {
        const f = new Intl.DateTimeFormat('en-US', {
            timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'short',
        });
        const parts = (ts) => Object.fromEntries(f.formatToParts(new Date(ts * 1000)).map(p => [p.type, p.value]));
        clock = {
            hm: ts => { const p = parts(ts); return `${p.hour}:${p.minute}`; },
            day: ts => { const p = parts(ts); return `${p.year}-${p.month}-${p.day}`; },
            zone: ts => ` ${parts(ts).timeZoneName}`,
        };
        clocks.set(timeZone, clock);
    }
    return clock;
}
/** Distinct at a glance, one code point each. */
const TAG_EMOJI = [...'🦊🐙🦉🐢🦋🐝🐳🦀🌵🍄🌻🍋🍒🥕🐸🐧🦄🐼🦁🐯🐨🦒🦓🐘🦔🦜🦩🐌🐞🌈🔥🎈'];
/** No look-alikes (0/o, 1/l/i). */
const TAG_CHARS = 'abcdefghjkmnpqrstuvwxyz23456789';
/**
 * A session's short, stable tag: an emoji and two characters by hash (`🦊a3`), so several tabs' lines can share
 * a thread and stay told apart. About 30,000 tags: collisions only matter among one burst's sessions.
 */
export function sessionTag(sessionId) {
    let h = 0x811c9dc5;
    for (let i = 0; i < sessionId.length; i++)
        h = Math.imul(h ^ sessionId.charCodeAt(i), 0x01000193) >>> 0;
    const n = h >>> 5;
    return `${TAG_EMOJI[h & 31]}${TAG_CHARS[n % 31]}${TAG_CHARS[Math.floor(n / 31) % 31]}`;
}
/** A gap in seconds, at most two units: `45s`, `3m 07s`, `4h 17m`, `2d 03h`. */
export function fmtGap(s) {
    const t = Math.max(0, Math.round(s));
    if (t < 60)
        return `${t}s`;
    const m = Math.floor(t / 60);
    if (m < 60)
        return `${m}m ${String(t % 60).padStart(2, '0')}s`;
    const h = Math.floor(m / 60);
    if (h < 24)
        return `${h}h ${String(m % 60).padStart(2, '0')}m`;
    return `${Math.floor(h / 24)}d ${String(h % 24).padStart(2, '0')}h`;
}
const NOUNS = {
    view: ['page load', 'page loads'],
    nav: ['URL change', 'URL changes'],
    click: ['click', 'clicks'],
    error: ['error', 'errors'],
    access: ['access event', 'access events'],
    resume: ['resumption', 'resumptions'],
    preview: ['link preview', 'link previews'],
};
const fmtN = (n) => n.toLocaleString('en-US');
/** `3 page loads`; an app's own kind reads `kind: 3`. */
export const countText = (kind, n) => {
    const noun = NOUNS[kind];
    return noun ? `${fmtN(n)} ${n === 1 ? noun[0] : noun[1]}` : `${kind}: ${fmtN(n)}`;
};
const span = (b, c) => `${c.day(b.firstTs)} ${b.firstTs === b.lastTs ? c.hm(b.firstTs) : `${c.hm(b.firstTs)}–${c.hm(b.lastTs)}`}${c.zone(b.lastTs)}`;
const via = (b) => (b.actor.via === 'grant' ? 'share link' : b.actor.via);
const ORDER = Object.keys(NOUNS);
const rank = (kind) => (ORDER.includes(kind) ? ORDER.indexOf(kind) : ORDER.length);
/** Kinds with notify≠off: the built-in kinds in a fixed order, then an app's own, alphabetically. */
const notified = (b) => Object.entries(b.notifyCounts).filter(([, n]) => n > 0).sort(([x], [y]) => rank(x) - rank(y) || (x < y ? -1 : x > y ? 1 : 0));
/** The parent message: who (unless posted as them), the notified counts, when, and the burst link. */
export function renderHeadline(b, o) {
    const { fmt } = o;
    const who = o.asActor ? (b.actor.via === 'sso' ? [] : [via(b)]) : [`${fmt.bold(fmt.esc(b.actor.name))} (${via(b)})`];
    const href = o.links?.burstHref?.(b);
    // A service link's notice leads: red with why, or green once it's clean again.
    const notice = b.notice
        ? [b.notice.color === 'red' ? `🔴 ${fmt.esc(b.notice.reasons.join('; '))}` : '🟢 clean again']
        : [];
    return [...notice, ...who, ...notified(b).map(([k, n]) => countText(k, n)), span(b, clockFor(o.links?.timeZone)), ...(href ? [fmt.link(href, 'activity')] : [])].join(' · ');
}
/** Stops on a path trail, kept to the last this many. */
export const TRAIL_KEEP = 10;
/** Sessions linked one by one, up to this many. */
export const MAX_SESSION_LINKS = 3;
/**
 * The details reply: the pages visited (view/nav lines, in order, repeats folded; left out for a kind with its own
 * reply, which lists them already), the sessions by tag, any omitted lines. Null when empty.
 */
export function renderDetails(b, o) {
    const { fmt } = o;
    const out = [];
    const stops = [];
    for (const line of b.lines) {
        if ((line.kind !== 'view' && line.kind !== 'nav') || line.notify === 'line' || !line.path)
            continue;
        const prev = stops.at(-1);
        if (prev && prev.path === line.path)
            prev.n++;
        else
            stops.push({ line, path: line.path, n: 1 });
    }
    if (stops.length) {
        const shown = stops.slice(-TRAIL_KEEP).map(({ line, path, n }) => {
            const href = o.links?.eventHref?.(line, b);
            return `${href ? fmt.link(href, path) : fmt.code(path)}${n > 1 ? ` ×${n}` : ''}`;
        });
        const earlier = stops.length - shown.length;
        out.push(`Pages${earlier ? ` (last ${shown.length} of ${stops.length})` : ''}: ${shown.join(' → ')}`);
    }
    const sessions = b.sessionIds.map(sid => {
        const href = o.links?.sessionHref?.(sid, b);
        return href ? fmt.link(href, sessionTag(sid)) : sessionTag(sid);
    });
    if (sessions.length) {
        const n = sessions.length;
        out.push(`${n > MAX_SESSION_LINKS ? `${fmtN(n)} sessions, latest` : n === 1 ? 'Session' : 'Sessions'}: ${sessions.slice(-MAX_SESSION_LINKS).join(' · ')}`);
    }
    if (b.omittedLines)
        out.push(`${fmtN(b.omittedLines)} earlier recorded lines not shown`);
    return out.length ? out.join('\n') : null;
}
/** Lines one reply lists, before `+N more`. */
export const MAX_LINES = 30;
/**
 * One notify=`line` kind's reply: a header, then each distinct line (oldest first; repeats folded in as `×N`), led
 * by its session's tag (a line with no session, a server's, takes the latest before it), its time linked to its
 * session, its page alongside unless the line names it. Null when the burst has none of that kind.
 */
export function renderKindLines(b, kind, o) {
    const { fmt } = o;
    const events = b.lines.filter(l => l.kind === kind && l.notify === 'line');
    if (!events.length)
        return null;
    const clock = clockFor(o.links?.timeZone);
    const sessionOf = new Map();
    let latest = null;
    for (const l of b.lines)
        sessionOf.set(l, (latest = l.sessionId ?? latest));
    const groups = new Map();
    for (const e of events) {
        const key = `${e.line ?? ''}\u0000${e.path ?? ''}\u0000${sessionOf.get(e) ?? ''}`;
        const g = groups.get(key);
        if (g)
            g.n++;
        else
            groups.set(key, { first: e, n: 1 });
    }
    const all = [...groups.values()];
    const max = o.max ?? MAX_LINES;
    const item = ({ first: e, n }) => {
        const sid = sessionOf.get(e) ?? null;
        const session = sid ? o.links?.sessionHref?.(sid, b) : null;
        const page = o.links?.eventHref?.(e, b);
        const text = e.line ?? e.path ?? kind;
        // The line is (or mentions) its page: link the line, and don't name the page twice.
        const names = !!e.path && (e.line === null || e.line.includes(e.path));
        const where = e.path && !names ? ` on ${page ? fmt.link(page, e.path) : fmt.code(e.path)}` : '';
        const body = names && page ? fmt.link(page, text) : fmt.esc(text);
        const time = session ? fmt.link(session, clock.hm(e.ts)) : clock.hm(e.ts);
        return `• ${sid ? `${sessionTag(sid)} ` : ''}${time} ${body}${where}${n > 1 ? ` ×${fmtN(n)}` : ''}`;
    };
    const out = [fmt.bold(countText(kind, b.notifyCounts[kind] ?? events.length)), ...all.slice(0, max).map(item)];
    if (all.length > max)
        out.push(`+${fmtN(all.length - max)} more`);
    return out.join('\n');
}
/** The notify=`line` kinds with lines in this burst, in first-seen order. */
export const lineKinds = (b) => [...new Set(b.lines.filter(l => l.notify === 'line').map(l => l.kind))];
/** Cut to `max` characters, ending on a whole line where it can. */
export function bound(text, max) {
    if (text.length <= max)
        return text;
    const room = max - 2;
    const cut = text.lastIndexOf('\n', room);
    return `${text.slice(0, cut > max / 2 ? cut : room)}\n…`;
}
/** Discord's single message per burst: the headline, details and each line kind, cut to fit 2000 characters. */
export function renderDiscordMessage(b, links) {
    const o = { fmt: DISCORD_FMT, ...(links ? { links } : {}) };
    const parts = [renderHeadline(b, o), renderDetails(b, o), ...lineKinds(b).map(k => renderKindLines(b, k, o))].filter((p) => !!p);
    return bound(parts.join('\n\n'), 2000);
}
/** Plain text, for an app's own logs or a sink without formatting. */
export function activityMessage(burst, max) {
    const counts = Object.entries(burst.notifyCounts).map(([kind, n]) => `${kind}: ${n}`).join(', ');
    const lines = [
        `${burst.actor.name} (${burst.actor.via})`,
        `${new Date(burst.firstTs * 1000).toISOString()} - ${new Date(burst.lastTs * 1000).toISOString()}`,
        counts,
    ];
    for (const event of burst.lines) {
        if (event.notify !== 'line')
            continue;
        lines.push(`[${event.kind}] ${event.line ?? event.path ?? event.kind}`);
    }
    if (burst.omittedLines)
        lines.push(`Earlier recorded lines omitted: ${burst.omittedLines}`);
    const text = lines.join('\n');
    return text.length <= max ? text : `${text.slice(0, max - 14)}\n[truncated]`;
}
