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
