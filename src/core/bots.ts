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
const BOT_PATTERN =
  /bot|crawl|spider|slurp|scrape|search|preview|fetcher|monitor|uptime|pingdom|curl\/|wget|python-requests|httpx|axios\/|go-http-client|java\/|okhttp|headless|phantomjs|puppeteer|playwright|lighthouse|facebookexternalhit|whatsapp|telegram|slackbot|discordbot|twitterbot|linkedinbot|embedly|quora link|bitlybot|vkshare|redditbot|applebot|semrush|ahrefs|mj12|dotbot|petalbot|bytespider|gptbot|claudebot|ccbot|perplexity/i

/** True when the user-agent identifies itself as automation. A missing UA counts as a bot. */
export function isBot(ua: string | null | undefined): boolean {
  if (!ua || !ua.trim()) return true
  return BOT_PATTERN.test(ua)
}

/**
 * Cloudflare's own verdict, when present. `CF-Verified-Bot: true` marks a
 * known-good crawler; trust it over the UA regex, which can't verify anything.
 */
export function isVerifiedBot(req: Request): boolean {
  return req.headers.get('CF-Verified-Bot') === 'true'
}

/** The check the gate applies before writing a `view` row. */
export function looksAutomated(req: Request): boolean {
  return isVerifiedBot(req) || isBot(req.headers.get('User-Agent'))
}

/** A link-preview or link-scanning agent: who to name in stats, and how to recognize its user-agent. */
export interface PreviewBot {
  name: string
  pattern: RegExp
}

/**
 * Agents that fetch a link to show (or vet) it, not a person opening it: chat and social unfurlers, mail clients'
 * image and link proxies, mail scanners. First match wins, so specific entries come before broad ones (iMessage
 * sends a UA naming Facebook's and Twitter's crawlers). Extend with `previewBots` on the gate.
 */
export const PREVIEW_BOTS: readonly PreviewBot[] = [
  { name: 'Slack', pattern: /Slackbot|Slack-ImgProxy/i },
  { name: 'iMessage', pattern: /facebookexternalhit\/[\d.]+ Facebot Twitterbot/i },
  { name: 'Facebook', pattern: /facebookexternalhit|Facebot/i },
  // Telegram's UA says "like TwitterBot".
  { name: 'Telegram', pattern: /TelegramBot/i },
  { name: 'X', pattern: /Twitterbot/i },
  { name: 'LinkedIn', pattern: /LinkedInBot/i },
  { name: 'Discord', pattern: /Discordbot/i },
  { name: 'WhatsApp', pattern: /WhatsApp/i },
  { name: 'Apple', pattern: /Applebot/i },
  { name: 'Google', pattern: /GoogleImageProxy|Google-PageRenderer|Google-Safety|Googlebot/i },
  { name: 'Microsoft', pattern: /SkypeUriPreview|Microsoft Office|ms-office|MSOffice|BingPreview|bingbot/i },
  { name: 'Mastodon', pattern: /Mastodon\//i },
  { name: 'Bluesky', pattern: /Cardyb|Bluesky/i },
  { name: 'mail scanner', pattern: /Mimecast|Proofpoint|Barracuda|urldefense/i },
  { name: 'Embedly', pattern: /Embedly/i },
  { name: 'Iframely', pattern: /Iframely/i },
  // Last resort: a self-described crawler. Not bare "bot", which is in some phones' model names ("Cubot").
  { name: 'bot', pattern: /\bbot\b|bot\/|crawler|spider|preview/i },
]

/**
 * The preview agent this user-agent names, or null for anything else (a browser, `curl`, a missing UA: those are
 * people or jobs, and redeem as before).
 */
export function previewBot(ua: string | null | undefined, bots: readonly PreviewBot[] = PREVIEW_BOTS): string | null {
  if (!ua) return null
  return bots.find(b => b.pattern.test(ua))?.name ?? null
}
