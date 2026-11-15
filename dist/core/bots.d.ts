/**
 * Bot filtering — one of the two things a hosted analytics tool does for you
 * that a first-party log has to do itself (the other is retention/rollup).
 *
 * Deliberately conservative. A false positive here is worse than a false
 * negative: mislabelling a real recipient as a bot suppresses their rows, and
 * the access log's whole job is to answer "did Bob open this?". Unknown agents
 * count as human.
 */
/** True when the user-agent identifies itself as automation. A missing UA counts as a bot. */
export declare function isBot(ua: string | null | undefined): boolean;
/**
 * Cloudflare's own verdict, when present. `CF-Verified-Bot: true` marks a
 * known-good crawler; trust it over the UA regex, which can't verify anything.
 */
export declare function isVerifiedBot(req: Request): boolean;
/** The check the gate applies before writing a `view` row. */
export declare function looksAutomated(req: Request): boolean;
/** A link-preview or link-scanning agent: who to name in stats, and how to recognize its user-agent. */
export interface PreviewBot {
    name: string;
    pattern: RegExp;
}
/**
 * Agents that fetch a link to show (or vet) it, not a person opening it: chat and social unfurlers, mail clients'
 * image and link proxies, mail scanners. First match wins, so specific entries come before broad ones (iMessage
 * sends a UA naming Facebook's and Twitter's crawlers). Extend with `previewBots` on the gate.
 */
export declare const PREVIEW_BOTS: readonly PreviewBot[];
/**
 * The preview agent this user-agent names, or null for anything else (a browser, `curl`, a missing UA: those are
 * people or jobs, and redeem as before).
 */
export declare function previewBot(ua: string | null | undefined, bots?: readonly PreviewBot[]): string | null;
