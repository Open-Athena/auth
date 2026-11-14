/**
 * Burst renderings for the Slack and Discord sinks (disky's thread model): a
 * parent line (who, counts, when), a details reply (pages, sessions), and one
 * reply per notify=`line` kind. Only notify=`line` events disclose detail.
 */
import type { ActivityBurst, ActivityLine } from './types.js';
export interface ActivityFmt {
    bold: (s: string) => string;
    link: (url: string, text: string) => string;
    code: (s: string) => string;
    /** Literal text (a page path, a client's error message), escaped for the sink. */
    esc: (s: string) => string;
}
/** Slack mrkdwn. `<`/`>`/`&` are escaped, so no text can form a link or a `<!channel>` mention. */
export declare const SLACK_FMT: ActivityFmt;
/** Discord markdown; the sink also sends `allowed_mentions: { parse: [] }`. */
export declare const DISCORD_FMT: ActivityFmt;
/** Links the app can supply: a page line's URL, a session's viewer, the burst in the app's own admin UI. */
export interface ActivityLinks {
    eventHref?: (line: ActivityLine, burst: ActivityBurst) => string | null;
    sessionHref?: (sessionId: string, burst: ActivityBurst) => string | null;
    burstHref?: (burst: ActivityBurst) => string | null;
}
/** A gap in seconds, at most two units: `45s`, `3m 07s`, `4h 17m`, `2d 03h`. */
export declare function fmtGap(s: number): string;
/** `3 page loads`; an app's own kind reads `kind: 3`. */
export declare const countText: (kind: string, n: number) => string;
export interface HeadlineOptions {
    fmt: ActivityFmt;
    links?: ActivityLinks;
    /** Posted as the actor (their name and face are the sender): leave out who, keep how for a link or service. */
    asActor?: boolean;
}
/** The parent message: who (unless posted as them), the notified counts, when, and the burst link. */
export declare function renderHeadline(b: ActivityBurst, o: HeadlineOptions): string;
/** Stops on a path trail, kept to the last this many. */
export declare const TRAIL_KEEP = 10;
/** Sessions linked one by one, up to this many. */
export declare const MAX_SESSION_LINKS = 3;
/** The details reply: the pages visited (view/nav lines, in order, repeats folded), the sessions, any omitted lines. Null when empty. */
export declare function renderDetails(b: ActivityBurst, o: {
    fmt: ActivityFmt;
    links?: ActivityLinks;
}): string | null;
/** Lines one reply lists, before `+N more`. */
export declare const MAX_LINES = 30;
/**
 * One notify=`line` kind's reply: a header, then each distinct line (oldest first; repeats folded in as `×N`), its
 * time linked to its session, its page alongside. Null when the burst has none of that kind.
 */
export declare function renderKindLines(b: ActivityBurst, kind: string, o: {
    fmt: ActivityFmt;
    links?: ActivityLinks;
    max?: number;
}): string | null;
/** The notify=`line` kinds with lines in this burst, in first-seen order. */
export declare const lineKinds: (b: ActivityBurst) => string[];
/** Cut to `max` characters, ending on a whole line where it can. */
export declare function bound(text: string, max: number): string;
/** Discord's single message per burst: the headline, details and each line kind, cut to fit 2000 characters. */
export declare function renderDiscordMessage(b: ActivityBurst, links?: ActivityLinks): string;
/** Plain text, for an app's own logs or a sink without formatting. */
export declare function activityMessage(burst: ActivityBurst, max: number): string;
