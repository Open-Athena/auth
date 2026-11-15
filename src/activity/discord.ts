import { activityText } from './shape.js'
import { type ActivityLinks, checkTimeZone, renderDiscordMessage } from './render.js'
import type { ActivitySink } from './types.js'

/** One message per burst (Discord webhooks have no threads to edit into), with the same links as Slack's. */
export interface DiscordActivityOptions extends ActivityLinks {
  id: string
  staffOnly: true
  webhook: string
  fetch?: typeof fetch
}

/** The webhook is a secret; errors never interpolate it or a provider response body. */
export function discordActivitySink(options: DiscordActivityOptions): ActivitySink {
  activityText(options.id, 'sink id')
  const webhook = new URL(options.webhook)
  if (webhook.protocol !== 'https:' || webhook.hostname !== 'discord.com' || !/^\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+$/.test(webhook.pathname)
    || webhook.search || webhook.hash || webhook.username || webhook.password || webhook.port) {
    throw new TypeError('activity: invalid Discord webhook')
  }
  if (options.staffOnly !== true) throw new TypeError('activity: Discord destination must be staff-only')
  checkTimeZone(options.timeZone)
  return {
    id: options.id,
    staffOnly: true,
    async send(burst, messageId) {
      const url = new URL(webhook)
      if (messageId) url.pathname += `/messages/${encodeURIComponent(messageId)}`
      else url.searchParams.set('wait', 'true')
      // Text is escaped by the renderer and cut to Discord's 2000 characters; mentions are suppressed below.
      const content = renderDiscordMessage(burst, options)
      const response = await (options.fetch ?? fetch)(url.href, {
        method: messageId ? 'PATCH' : 'POST',
        headers: { 'content-type': 'application/json' },
        signal: AbortSignal.timeout(10_000),
        body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
      })
      if (!response.ok) {
        // Discord's JSON error code (e.g. 10015 Unknown Webhook) says why; it never echoes the webhook.
        const code = (await response.json().catch(() => null) as { code?: unknown } | null)?.code
        throw new Error(`activity: Discord HTTP ${response.status}${Number.isSafeInteger(code) ? ` (${code})` : ''}`)
      }
      const result = await response.json() as { id?: string }
      if (typeof result.id !== 'string' || !result.id) throw new Error('activity: Discord returned no message ID')
      return result.id
    },
  }
}
