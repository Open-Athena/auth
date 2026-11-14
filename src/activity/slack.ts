import { activityText } from './shape.js'
import { type ActivityLinks, bound, lineKinds, renderDetails, renderHeadline, renderKindLines, SLACK_FMT } from './render.js'
import type { ActivityActor, ActivityBurst, ActivitySink } from './types.js'

/** Who a burst's posts are sent as. Needs the bot's `chat:write.customize` scope; without it Slack posts as the bot. */
export interface ActivitySender {
  username: string
  /** An https image URL Slack can fetch. */
  iconUrl?: string
}

export interface SlackActivityOptions extends ActivityLinks {
  id: string
  staffOnly: true
  token: string
  channel: string
  /**
   * Post as the actor: resolve their name and face from the app's own trusted data (a grant's subject, a
   * profile). Null, or no hook, posts as the bot with the actor named in the text.
   */
  actorSender?: (actor: ActivityActor, burst: ActivityBurst) => ActivitySender | null | Promise<ActivitySender | null>
  /** Replace the parent message's text (mrkdwn; escape what you include). The thread replies are unchanged. */
  renderBurst?: (view: { burst: ActivityBurst; asActor: boolean; links: ActivityLinks }) => { text: string }
  fetch?: typeof fetch
}

/** Slack's error codes are short fixed strings (`not_in_channel`); anything else is left out of logs. */
function slackErrorCode(error: unknown): string {
  return typeof error === 'string' && /^[a-z_]{1,64}$/.test(error) ? ` (${error})` : ''
}

/** Slack's limit is far higher; this keeps one message readable. */
const MAX_TEXT = 3500

/**
 * One Slack thread per burst, edited as it grows: a parent line (who, counts, when), a details reply (pages,
 * sessions), and one reply per notify=`line` kind. Posts as the actor when `actorSender` resolves one.
 */
export function slackActivitySink(options: SlackActivityOptions): ActivitySink {
  activityText(options.id, 'sink id')
  activityText(options.channel, 'Slack channel')
  activityText(options.token, 'Slack token')
  if (options.staffOnly !== true) throw new TypeError('activity: Slack destination must be staff-only')
  const links: ActivityLinks = {
    ...(options.eventHref ? { eventHref: options.eventHref } : {}),
    ...(options.sessionHref ? { sessionHref: options.sessionHref } : {}),
    ...(options.burstHref ? { burstHref: options.burstHref } : {}),
  }

  async function call(method: 'chat.postMessage' | 'chat.update', body: Record<string, unknown>): Promise<string> {
    const response = await (options.fetch ?? fetch)(`https://slack.com/api/${method}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${options.token}`, 'content-type': 'application/json' },
      signal: AbortSignal.timeout(10_000),
      body: JSON.stringify({ channel: options.channel, parse: 'none', unfurl_links: false, unfurl_media: false, ...body }),
    })
    if (!response.ok) throw new Error(`activity: Slack HTTP ${response.status}`)
    const result = await response.json() as { ok?: boolean; ts?: string; error?: unknown }
    if (result.ok !== true || typeof result.ts !== 'string' || !result.ts) throw new Error(`activity: Slack rejected message${slackErrorCode(result.error)}`)
    return result.ts
  }

  return {
    id: options.id,
    staffOnly: true,
    async send(burst, messageId, ctx) {
      const sender = await options.actorSender?.(burst.actor, burst) ?? null
      const asActor = sender !== null
      // `username`/`icon_url` apply when a message is created; an edit keeps the sender it was posted as.
      const as = sender ? { username: sender.username.slice(0, 80), ...(sender.iconUrl ? { icon_url: sender.iconUrl } : {}) } : {}
      const headline = options.renderBurst?.({ burst, asActor, links }).text ?? renderHeadline(burst, { fmt: SLACK_FMT, links, asActor })
      const text = bound(headline, MAX_TEXT)
      const parent = messageId ? (await call('chat.update', { ts: messageId, text }), messageId) : await call('chat.postMessage', { text, ...as })
      if (!ctx) return parent
      const parts = { ...ctx.parts }
      if (!messageId) await ctx.save(parent, parts)
      const replies: [string, string | null][] = [
        ['details', renderDetails(burst, { fmt: SLACK_FMT, links })],
        // `kind:` keeps an app's own kind named `details` from sharing that reply.
        ...lineKinds(burst).map(kind => [`kind:${kind}`, renderKindLines(burst, kind, { fmt: SLACK_FMT, links })] as [string, string | null]),
      ]
      for (const [slot, reply] of replies) {
        if (!reply) continue
        const body = bound(reply, MAX_TEXT)
        const existing = parts[slot]
        if (existing) {
          await call('chat.update', { ts: existing, text: body })
        } else {
          parts[slot] = await call('chat.postMessage', { thread_ts: parent, text: body, ...as })
          await ctx.save(parent, parts)
        }
      }
      return parent
    },
  }
}
