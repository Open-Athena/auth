import { LeaseLostError, SlackApiError, SlackClient } from '@open-athena/thrds'
import { activityText } from './shape.js'
import { type ActivityLinks, bound, checkTimeZone, lineKinds, renderDetails, renderHeadline, renderKindLines, SLACK_FMT } from './render.js'
import type { ActivityActor, ActivityBurst, ActivitySink, ActivityThreadState } from './types.js'

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

/**
 * A Slack failure as the sink reports it. `SlackApiError` carries Slack's whole reply, so only its short error code
 * (`not_in_channel`, and only one that looks like one) or HTTP status is kept.
 */
export function wrapSlackError(e: unknown): unknown {
  if (e instanceof LeaseLostError) return new Error('activity: delivery lease lost')
  if (!(e instanceof SlackApiError)) return e
  if (e.kind === 'timeout') return new Error('activity: Slack timeout')
  if (e.kind === 'transport') return new Error('activity: Slack request failed')
  if (e.status !== 200) return new Error(`activity: Slack HTTP ${e.status}`)
  return new Error(`activity: Slack rejected message${e.slackCode ? ` (${e.slackCode})` : ''}`)
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
    ...(options.timeZone ? { timeZone: options.timeZone } : {}),
  }
  checkTimeZone(options.timeZone)

  // No retries: the feed's `defer` backoff is the retry policy, and an in-call wait could outlive the delivery lease.
  const client = new SlackClient({
    token: options.token, channel: options.channel, parse: 'none', timeoutMs: 10_000, retries: 0,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  })
  type Text = { text: string; username?: string; iconUrl?: string }
  const call = async (write: () => Promise<{ id: string }>): Promise<string> => {
    try {
      return (await write()).id
    } catch (e) {
      throw wrapSlackError(e)
    }
  }
  const post = (msg: Text, threadTs?: string) => call(() => client.post(msg, threadTs))
  const edit = (ts: string, text: string) => call(() => client.edit(ts, { text }))

  return {
    id: options.id,
    staffOnly: true,
    async send(burst, messageId, ctx) {
      const sender = await options.actorSender?.(burst.actor, burst) ?? null
      const asActor = sender !== null
      // `username`/`icon_url` apply when a message is created; an edit keeps the sender it was posted as.
      const as = sender ? { username: sender.username.slice(0, 80), ...(sender.iconUrl ? { iconUrl: sender.iconUrl } : {}) } : {}
      const headline = options.renderBurst?.({ burst, asActor, links }).text ?? renderHeadline(burst, { fmt: SLACK_FMT, links, asActor })
      const text = bound(headline, MAX_TEXT)
      const parent = messageId ? (await edit(messageId, text), messageId) : await post({ text, ...as })
      if (!ctx) return parent
      const state = structuredClone(ctx.state) as ActivityThreadState
      const save = async () => { if (!(await ctx.put(state))) throw new Error('activity: delivery lease lost') }
      if (!messageId) {
        state.parent = { ts: parent, hash: '' }
        await save()
      }
      const replies: [string, string | null][] = [
        ['details', renderDetails(burst, { fmt: SLACK_FMT, links })],
        // `kind:` keeps an app's own kind named `details` from sharing that reply.
        ...lineKinds(burst).map(kind => [`kind:${kind}`, renderKindLines(burst, kind, { fmt: SLACK_FMT, links })] as [string, string | null]),
      ]
      for (const [slot, reply] of replies) {
        if (!reply) continue
        const body = bound(reply, MAX_TEXT)
        const existing = state.slots[slot]?.ts
        if (existing) {
          await edit(existing, body)
        } else {
          state.slots[slot] = { ts: await post({ text: body, ...as }, parent), hash: '' }
          await save()
        }
      }
      return parent
    },
  }
}
