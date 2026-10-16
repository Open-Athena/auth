/**
 * Bot filtering — one of the two things a hosted analytics tool does for you
 * that a first-party log has to do itself (the other is retention/rollup).
 *
 * Deliberately conservative. A false positive here is worse than a false
 * negative: mislabelling a real recipient as a bot suppresses their rows, and
 * the access log's whole job is to answer "did Bob open this?". Unknown agents
 * count as human.
 */
/**
 * Self-identifying automation. Crawlers, monitors, link unfurlers and HTTP
 * libraries all say so in their UA; nothing here tries to catch a bot that is
 * actively lying, which is unwinnable and not what this is for.
 */
const BOT_PATTERN = /bot|crawl|spider|slurp|scrape|search|preview|fetcher|monitor|uptime|pingdom|curl\/|wget|python-requests|httpx|axios\/|go-http-client|java\/|okhttp|headless|phantomjs|puppeteer|playwright|lighthouse|facebookexternalhit|whatsapp|telegram|slackbot|discordbot|twitterbot|linkedinbot|embedly|quora link|bitlybot|vkshare|redditbot|applebot|semrush|ahrefs|mj12|dotbot|petalbot|bytespider|gptbot|claudebot|ccbot|perplexity/i;
/** True when the user-agent identifies itself as automation. A missing UA counts as a bot. */
export function isBot(ua) {
    if (!ua || !ua.trim())
        return true;
    return BOT_PATTERN.test(ua);
}
/**
 * Cloudflare's own verdict, when present. `CF-Verified-Bot: true` marks a
 * known-good crawler; trust it over the UA regex, which can't verify anything.
 */
export function isVerifiedBot(req) {
    return req.headers.get('CF-Verified-Bot') === 'true';
}
/** The check the gate applies before writing a `view` row. */
export function looksAutomated(req) {
    return isVerifiedBot(req) || isBot(req.headers.get('User-Agent'));
}
