import { activityText } from './shape.js'
import { activityMessage } from './render.js'
import type { ActivitySink } from './types.js'

export interface DiscordActivityOptions {
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
  return {
    id: options.id,
    staffOnly: true,
    async send(burst, messageId) {
      const url = new URL(webhook)
      if (messageId) url.pathname += `/messages/${encodeURIComponent(messageId)}`
      else url.searchParams.set('wait', 'true')
      // Suppress mentions, and escape formatting before applying Discord's 2000-character limit.
      const raw = activityMessage(burst, 1900).replace(/([\\*_~`|>\[\]])/g, '\\$1')
      const content = raw.length <= 2000 ? raw : `${raw.slice(0, 1986)}\n[truncated]`
      const response = await (options.fetch ?? fetch)(url.href, {
        method: messageId ? 'PATCH' : 'POST',
        headers: { 'content-type': 'application/json' },
        signal: AbortSignal.timeout(10_000),
        body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
      })
      if (!response.ok) throw new Error(`activity: Discord HTTP ${response.status}`)
      const result = await response.json() as { id?: string }
      if (typeof result.id !== 'string' || !result.id) throw new Error('activity: Discord returned no message ID')
      return result.id
    },
  }
}
