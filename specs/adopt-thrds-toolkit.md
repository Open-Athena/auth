# `slackActivitySink` onto `@open-athena/thrds` (`syncSlots`)

From the thrds session (2026-11-18). This is the design for [decision 4][reuse-d4] of the toolkit survey: auth's Slack activity sink moves onto the toolkit's slotted threads, and `@open-athena/auth/activity` becomes the one burst-thread implementation, so disky can delete its hand-copied one (§6). Toolkit read at thrds `ts` @ `f4955b6` (0.2.0, not yet on npm: use the [`ts-dist`][ts-dist] build by SHA until `ts-v0.2.0` is tagged).

## 1. What changes, and why bother

Today the sink stores one ts per slot and no content hash ([`types.ts:124`][types], [`d1-activity.ts:195`][d1]), so every send re-edits the parent and every reply ([`slack.ts:84-94`][sink]). It also has no recovery when a staff member deletes a message: a `chat.update` on it fails `message_not_found` on every retry, at the 15-min backoff cap, indefinitely. `syncSlots` ([`slots.ts:121-308`][slots]) gives:

- **Hash-skip.** A reply whose rendering didn't change is not touched. A burst that only gained a count-only `click` usually edits the parent alone, and a version bump from a `notify: off` event makes no Slack calls.
- **Write-ahead `pending` plus metadata tags.** A crash between a post landing and its checkpoint is adopted, not re-posted. That closes the duplicate window `index.ts:9-12` and README:262 document today, when the token can read history (see G2).
- **REPOST.** A deleted parent or reply is re-posted instead of wedging the burst.

## 2. Mapping: sink piece → toolkit

| auth (file:line) | Becomes | Why |
|---|---|---|
| `call()` transport, [`slack.ts:52-63`][sink]: Bearer JSON POST, `parse:'none'`, `unfurl_*:false`, 10 s timeout, `ok`+`ts` check | `new SlackClient({ token, channel, fetch, parse: 'none', timeoutMs: 10_000, retries: 0 })` → `post`/`edit` ([toolkit `slack.ts:390-414`][tk-slack]) | Same request body keys for plain text (`suppressUnfurls` defaults true). `retries: 0`: auth's `defer` backoff is the retry policy, and the toolkit's in-call sleeps can outlive the lease (G3). The `ts` check has no toolkit equivalent (G4), so it stays as a guard on the result. |
| `slackErrorCode` sanitizing, [`slack.ts:27-30`][sink] | **Stays**, as `wrapSlackError(e)` at the sink boundary: a `SlackApiError` with status 200 and a code matching `/^[a-z_]{1,64}$/` (not `unknown_error` / `invalid_json`) → `activity: Slack rejected message (<code>)`; status ≠ 200 → `activity: Slack HTTP <status>`; `timeout` → `activity: Slack timeout`; `LeaseLostError` → `activity: delivery lease lost` | `SlackApiError.message` embeds Slack's raw `error`, and `.response` holds the whole body (G5). Error text is pinned by `activity-bridges.test.ts:105-121`. The wrap goes *around* `syncSlots`, never inside it, because `syncSlots` branches on `SlackApiError.code`. |
| Sender, [`slack.ts:69-72`][sink] (`username.slice(0,80)`, `icon_url`) | Per-`Msg` `username` / `iconUrl` ([`core.ts:35-55`][tk-core]) on the parent and every slot msg | Same post-only semantics. `msgHash` excludes the sender, so a sender change is not an edit, which matches today. The `.slice(0, 80)` stays (G10). `ActivitySender` / `actorSender` are unchanged public API. |
| `MAX_TEXT` + `bound`, [`slack.ts:33`][sink], [`render.ts:234-239`][render] | **Stays** | The toolkit's `bound` ([`mrkdwn.ts:34`][tk-mrkdwn]) cuts by code point and appends `…`. Auth's prefers a line break (`\n…`), and the Discord sink shares it (G9). |
| `SLACK_FMT` escaping, [`render.ts:17-22`][render] | **Stays** | `esc` is byte-identical to the toolkit's `escape`. `link` differs: auth strips `<>|` from labels and encodes `<` in hrefs, while the toolkit escapes labels and leaves `<` (G9). Keeping `render.ts` free of thrds imports also means a Discord-only app never loads thrds. |
| Headline / `renderBurst`, [`slack.ts:73-74`][sink] | **Stays** | Domain rendering is out of the toolkit's scope ([reuse spec][reuse-d4], "Still out of scope"). |
| Parent post/edit + slot loop + `ctx.save`, [`slack.ts:75-94`][sink] | `syncSlots(client, ctxStore(ctx), { key, parent, slots })` | The core of this spec (§3). |
| No-`ctx` path, [`slack.ts:76`][sink] (parent only) | `upsert(client, memoryStore(seed), key, parentMsg)`, seeded `{ parent: { ts: messageId, hash: '' } }` when `messageId` is set | Keeps `send(burst, null)` / `send(burst, ts)` working for direct callers. Recovery needs no persistence there. |
| `ActivityClaim.parts`, `checkpoint`, `ActivitySendContext`, [`types.ts:118-179`][types]; ctx in [`index.ts:116-123`][index] | Reshaped (§3) | The store holds the toolkit's state. |

## 3. Design: `ActivitySendContext` *is* the `SlotStore` (option A, tightened)

**Chosen:** auth keeps the lease (`ActivityStore.claim`, `leaseS`, `defer`). `syncSlots` runs **without** `leaseS` over a one-key `SlotStore` adapter on the send context. The checkpoint payload becomes the toolkit's `SlotState` verbatim: hashes and `pending` live in the existing `parts` column, and `message_id` stays the canonical parent ts.

Rejected alternatives:

- **B: thrds `d1Store` (its own `thrds_slots` table and leases).** It puts two leases on one send, and two tables have to agree on the parent ts that `complete()`, QUIET and the Discord sink read.
- **C: keep auth's loop and just add `msgHash`.** It keeps the duplicate window and the deleted-message wedge, and leaves disky nothing shared to adopt.

### Types ([`types.ts`][types])

```ts
/** Structurally thrds' `SlotState` (a test pins the equality), so types.ts needn't import thrds. */
export interface ActivityThreadState {
  parent?: { ts: string; hash: string }
  slots: Record<string, { ts: string; hash: string }>
  pending?: { slot: string | null; hash: string; at: number }
}
export interface ActivityClaim { token: string; messageId: string | null; failures: number; state: ActivityThreadState }
// ActivityStore:
checkpoint(burstId: string, sink: string, token: string, state: ActivityThreadState): Promise<boolean>
export interface ActivitySendContext {
  state: Readonly<ActivityThreadState>
  /** Persist under the delivery lease; false once it's lost. */
  put(state: ActivityThreadState): Promise<boolean>
  /** The feed's clock (epoch s): `pending.at` and the recovery window use it, so tests stay deterministic. */
  nowS(): number
}
```

Sink side ([`slack.ts`][sink]): `key = \`activity:${options.id}:${burst.id}\``. The sink id is in the key so two sinks posting to one channel never adopt each other's posts. `ctxStore = { get: async k => k === key ? structuredClone(ctx.state) : undefined, put: (_k, s) => ctx.put(s) }`. Slots are `details` and then `kind:<k>`, in `lineKinds` order, leaving out null renderings. `prune` stays off, so a kind that ages out of `burst.lines` keeps its last reply, as today. `syncSlots(..., { now: () => ctx.nowS() * 1000 })` returns `r.ts`, the possibly re-posted parent, which `deliverTo` passes to `complete()` as today.

### Persistence and back-compat ([`d1-activity.ts`][d1])

No SQL migration. `parts` stays `TEXT NOT NULL DEFAULT '{}'` ([`0003_threads.sql`][m3]).

- **`claim` parses both shapes.** A value with an object `slots` key is the new shape. Legacy slot names are only `details` / `kind:*`, so no legacy row has a `slots` key. A legacy flat `{slot: ts}` maps to `{ slots: { [slot]: { ts, hash: '' } } }`. Then `parent` is reconciled with `message_id`: null or QUIET (`'-'`) drops it, and a ts that disagrees with the JSON becomes `{ ts: message_id, hash: '' }`. An empty hash never matches, so the first send after deploy edits everything once (today's behavior) and records hashes from then on.
- **`checkpoint` writes the JSON and mirrors `message_id = state.parent?.ts ?? NULL`.** `message_id` may now be NULL under a live claim: a parent `pending` is saved *before* the parent exists. `activityText(messageId)` moves into the non-null branch. `complete()` is unchanged.

### How it composes with the feed ([`index.ts:93-135`][index])

| Feed piece | With `syncSlots` |
|---|---|
| **Auth's "don't post the parent twice" guarantee** (post, then `ctx.save`) | Kept, because `syncSlots` saves `state.parent` right after the post (`slots.ts:190-193`). `pending` is strictly additive: it is saved *before* each post, so the post→save window becomes "adopt via metadata" instead of "duplicate". |
| **QUIET** (`complete(QUIET)`, no send) | Untouched. A QUIET row has no `parent`, so a burst that turns notable later gets a fresh POST. |
| **`complete(version)`** | Unchanged; it gets `r.ts`. `fenced` (the version moved mid-send) is still safe: the state is checkpointed, and the next claim re-sends and SKIPs whatever is current. |
| **`defer`** | Unchanged. It keeps `parts`, so a leftover `pending` survives to the next claimant, which resolves it with ADOPT or a fresh post. |
| **Lease lost** | `put` returns false, `syncSlots` throws `LeaseLostError`, the sink maps it to today's message, and `deliverTo`'s `defer` is a no-op on the stale token, as now. |

### What becomes visible in Slack

- **Every post and edit carries metadata** (`tagSlot`, `slots.ts:97-106`): `event_type: 'thrds_slot'` and `{ thrds_key: 'activity:<sink>:<burst uuid>', thrds_slot: ''|'details'|'kind:<k>', thrds_hash }`.
  - The Slack client doesn't render it.
  - API readers of the channel (other apps with history or metadata-event access) can see it: a burst UUID and kind names, no actor data. Acceptable for a staff-only channel.
  - Request bodies gain a `metadata` key, so the exact-body tests change (§4).
- **Deleted messages come back.** A parent deleted in Slack is re-posted on the burst's next send, with all replies, as a new thread. So deleting a thread to dismiss it no longer works (G6).
- **New read scopes, for recovery only.** Recovery needs `groups:history` (private staff channel) or `channels:history`, and REPOST of a reply needs the same scope. Today's documented scopes are `chat:write` and optionally `chat:write.customize` ([adoption doc:52][adopt-doc]). Without the read scope, recovery throws `missing_scope`, and the burst wedges until G2 lands.

## 4. Migration steps (one commit each, `pnpm typecheck && pnpm test` green at every step)

Prerequisite, in thrds before tagging `ts-v0.2.0`: **G1, G4 and G5** (G2 and G3 are strongly wanted). Without G1, step 4's failure test needs `auth.test` + `conversations.replies` round-trips, and the fake `fetch` would have to serve GETs (it `JSON.parse`s a body that GETs don't have).

1. **Dependency.** Add `@open-athena/thrds` (the `ts-dist` SHA for now). It is auth's first runtime `dependency`, but thrds itself has none, and only `./activity/slack` imports it. No code changes; the suite passes unchanged.
2. **State shape, own loop kept.**
   - Do the `types.ts` / `d1-activity.ts` / `index.ts` changes from §3.
   - `slack.ts` reads `ctx.state.slots[slot]?.ts`, writes `{ ts, hash: '' }`, and keeps `state.parent`.
   - **Deliberately updated:** the `t.parts()` assertions at `activity-threads.test.ts:66,98,108`, now exact JSON of the new shape with `hash: ''`. Every Slack-call assertion passes unchanged.
   - **New:** a legacy row (`message_id '1.000'`, `parts '{"details":"2.000"}'`) claims as `{ parent: { ts: '1.000', hash: '' }, slots: { details: { ts: '2.000', hash: '' } } }`.
   - **New:** QUIET `'-'` claims as `{ slots: {} }`.
   - **New:** `expectTypeOf<ActivityThreadState>().toEqualTypeOf<SlotState>()`.
3. **Transport only.** `call()` → `SlackClient.post` / `edit` plus `wrapSlackError` and a `ts` guard; still auth's loop. **Unchanged:** every existing test, including `activity-bridges.test.ts:78-81`. A plain-text `Msg` isn't rich, so no metadata is sent yet. The error strings at `:116-121` also pass unchanged. **New, exact error strings:**
   - `{ ok: true }` with no `ts` → `activity: Slack rejected message`
   - HTTP 429 → `activity: Slack HTTP 429`
   - an aborted fetch → `activity: Slack timeout`
4. **`syncSlots`.** Replace `slack.ts:75-94`.
   - **Deliberately updated:**
     - `activity-threads.test.ts:61-66`: bodies gain `metadata`. `parts` gains real hashes, with the expected value built as `msgHash(tagSlot({ text }, key, slot))` (exact, no placeholder).
     - `:71-75`: the `details` update disappears (unchanged → SKIP). Expected: two `chat.update`s, parent and `kind:error`.
     - `:102-108`: after a refused reply post, the retry is exactly `[['chat.postMessage', '1.000']]`. The parent and `details` SKIP, and with G1 there's no `pending` to resolve.
     - `activity-bridges.test.ts:78-81`: both bodies gain the parent's `metadata`.
   - **Unchanged:** `activity-threads.test.ts:86-90,120-129,140-144,153-160` and `activity-service.test.ts` (each burst is posted fresh, and its edits change text).
   - **New tests**, exact `calls` and exact `parts`, with the fake `fetch` extended to answer `auth.test`, `conversations.history` and `conversations.replies` GETs from a recorded message list:
     - (a) The parent post lands, then the fetch throws `TimeoutError`. The next flush makes `auth.test` + `conversations.history` calls, ADOPTs, and never posts the parent again.
     - (b) The parent `chat.update` returns `message_not_found`. A new parent is posted, then `details` and `kind:error` are posted under it, and `message_id` is the new ts.
     - (c) A reply `chat.update` returns `message_not_found`. `conversations.replies` shows the thread is alive, and only that reply is re-posted.
     - (d) `checkpoint` is fenced mid-send → `activity: delivery lease lost`.
     - (e) Only a `notify: off` event arrives → status `sent`, zero Slack calls.
     - (f) `missing_scope` during recovery → the G2 fallback (posts once, no ADOPT).
5. **Docs.**
   - README:262 and the adoption doc ([`:44`][adopt-doc], `:48`, `:52`): hash-skip; "a crash after posting may duplicate" → "is adopted when the token has `groups:history`/`channels:history`"; REPOST of deleted messages; the metadata tags.
   - The `index.ts:9-12` header.
   - Move this spec to `specs/done/`.
6. **Release.** Once thrds `0.2.0` is on npm, pin `^0.2.0` (a git dep in `dependencies` blocks auth's own npm publish). Bump auth to `0.2.0`: `ActivityStore.checkpoint`, `ActivityClaim` and `ActivitySendContext` are backward-incompatible for third-party stores and sinks.

## 5. Risks / behavior changes

- **Rollback duplicates replies.** Pre-migration code reading a new-shape `parts` finds no `details` / `kind:*` keys, so it posts fresh replies into live threads (the parent survives, via `message_id`). Roll back only between bursts, or reset `parts` to `'{}'` for in-flight bursts first.
- **D1 write amplification.** Up to `2·posts + edits` checkpoints per send, against `posts` today (G7). Slack calls drop.
- **A dismissed thread is re-posted** (G6). Missing read scopes turn crash recovery into a permanent failure until G2.
- **Timeout errors change text** (raw `TimeoutError` → `activity: Slack timeout`). HTTP 429 is still `Slack HTTP 429`, since `retries: 0`.

## 6. disky follow-up (its own spec, after auth `0.2.0`)

disky pins `@open-athena/auth` at `4ae2079` and runs its own feed, `site/functions/_lib/activity.ts`.

**Deletes:**
- `ensurePost`, `PENDING` and `CLAIM_STALE_MS` (`:228-288`).
- The Slack and Discord halves of `render()` (`:374-445`).
- `keepNotice` / `priorRed` / `noticeFor` (→ auth's `serviceRed`).
- Most rendering in `activityShape.ts` (`SLACK`/`DISCORD` `Fmt`, `renderHeadline`/`renderDetails`/`renderLines`/`renderDiscord`, `fmtGap`, `countText`) → auth `render.ts`.
- Raw `slackApi` / `slackScopes` / `slackPeople` in `slack.ts` → thrds (`SlackClient`, `canCustomizeSender`, `userByEmail`).

**Keeps, as hooks:**
- `senderOf` / `slackSenderOf` → its `actorSender`; faces via thrds `/avatar` `publishAvatar` + `d1AvatarStore`, replacing `publicAvatar.ts`.
- `hostTag` / `highlights` → `renderBurst`.

**Must be solved before it can switch:**
- **Table collision.** Its `activity_posts(burst_id, sink, part, msg_id, claimed_ms)` collides by name with auth's `activity_posts`. It needs a rename or drop migration before it applies `migrations/activity/`.
- **Throttling.** Its 20 s `THROTTLE_MS` / `dirty` trailing render has no auth equivalent (`index.ts:6`: "no … throttling").
- **Forced re-render.** `rerender` of a format change: auth only sends when `version` advanced, so it needs a forced re-send, which hash-skip then makes cheap.
- **Permalinks.** `slackParent` → read `message_id` and use thrds `buildPermalink`.

## 7. Gaps in the toolkit (thrds `ts` @ `f4955b6`)

- **G1: a refused post leaves `pending` set.** `post`'s catch (`slots.ts:178-189`) clears it only on `thread_not_found` / `message_not_found`. An `ok:false` body (`ratelimited`, `not_in_channel`, `msg_too_long`, `invalid_auth`) or an HTTP 429/4xx means nothing landed, yet the next run does a recovery read (`auth.test` + `conversations.history|replies`) that needs history scopes. Fix: clear `pending` for any `SlackApiError` except `timeout`, `http_5xx` and `invalid_json`; keep it only for ambiguous failures (abort, network, 5xx).
- **G2: recovery and REPOST need read scopes, and a missing scope wedges the key.**
  - `find` (`slots.ts:157-162`) and `threadGone` (`:235-243`) call `history` / `list`. Those need `channels:history`, or `groups:history` for the private channels activity goes to.
  - A `missing_scope` / `not_in_channel` there throws on every run, so the key never syncs again.
  - README:69 says "no Slack reads are needed", and no scope is documented.
  - Want: a `recover: 'metadata' | 'none'` option, falling back to `none` (clear `pending`, post: at-least-once, today's auth behavior) on a scope error, plus an action marking it. Document the scopes.
- **G3: retry sleeps aren't bounded by the caller's lease.** `slackCall` sleeps an unbounded `Retry-After`, or 30/60/90 s for a body `ratelimited` (`api.ts:122-139`). Inside a 60 s lease, a post landing after such a sleep races the next claimant, which has already resolved the same `pending` as not found, so it posts twice. Want `maxRetryWaitMs` (or a `deadline`) that fails fast instead. Auth uses `retries: 0` until then.
- **G4: `post` doesn't validate `ts`.** `slack.ts:403-404` casts `result["ts"] as string`, so `{ok:true}` without `ts` records `parent.ts = undefined`. JSON drops it, and the next run posts a second parent. It should throw `SlackApiError(method, 'invalid_response')`.
- **G5: `SlackApiError` can't be logged safely or classified.**
  - `code` mixes Slack's own codes with synthesized ones (`unknown_error`, `invalid_json`, `http_<n>`, `timeout`, and `ratelimited` for an HTTP 429).
  - `message` embeds the raw, unsanitized `error` string, and `response` carries the full body.
  - Want: `slackCode?` set only when Slack sent one (bounded to `/^[a-z_.]{1,64}$/`, else dropped), `kind: 'slack' | 'http' | 'timeout' | 'transport'`, and a message built only from those. Auth's `wrapSlackError` is the workaround.
- **G6: no opt-out of REPOST.** `message_not_found` on edit always re-posts (`slots.ts:221-227`, `:259-266`). Deliberate deletion isn't distinguishable from loss. Want `onGone: 'repost' | 'forget' | 'throw'` (`forget` drops the slot, or the whole thread for a parent, and reports `GONE`).
- **G7: every edit saves.** `slots.ts:229-230` puts after each EDIT, on top of pending-before and record-after each POST. Edits need no write-ahead (a lost hash just re-edits once). Saving hash updates once at the end, or with the next POST's pending write, roughly halves store writes.
- **G8: recovery and existence reads are heavier than needed.**
  - `list` / `history` resolve `botIds()` via `auth.test` first (`slack.ts:300-302`, `:321`).
  - `threadGone` paginates the whole thread (`limit: 200`) just to test existence, where `conversations.replies` with `limit: 1` would do.
  - `find` doesn't need the `editable` computation at all.
- **G9: `bound` and `link` aren't drop-in replacements for auth's.**
  - `bound` (`mrkdwn.ts:34-39`) has no prefer-a-line-break mode. A `{ atLine: true }` option (cut at the last `\n` past half, ellipsis `\n…`) would let auth delete `render.ts:234-239` and fix its UTF-16 slicing, which can split a session-tag emoji.
  - `link` (`mrkdwn.ts:11-14`) leaves `<` unencoded in hrefs.
- **G10: `Msg.username` isn't bounded.** `post` (`slack.ts:393-396`) passes it through, while `senderFor` slices to Slack's 80-character limit. `post` should slice too.
- **G11 (nits):**
  - A one-key store needs a hand adapter. `syncSlots` could take `{ get(): SlotState | undefined; put(s): Promise<boolean> }` directly.
  - The exports map has only an `import` condition (no `default`), so CJS / `require` resolution fails. auth's own exports use `default`.

[reuse-d4]: https://github.com/Open-Athena/thrds/blob/ts/specs/slack-toolkit-reuse.md#decisions-2026-11-18-ryan-go-for-all
[ts-dist]: https://github.com/Open-Athena/thrds/tree/ts-dist
[slots]: https://github.com/Open-Athena/thrds/blob/f4955b6/src/slots.ts
[tk-slack]: https://github.com/Open-Athena/thrds/blob/f4955b6/src/slack.ts
[tk-core]: https://github.com/Open-Athena/thrds/blob/f4955b6/src/core.ts
[tk-mrkdwn]: https://github.com/Open-Athena/thrds/blob/f4955b6/src/mrkdwn.ts
[sink]: ../src/activity/slack.ts
[types]: ../src/activity/types.ts
[index]: ../src/activity/index.ts
[render]: ../src/activity/render.ts
[d1]: ../src/adapters/d1-activity.ts
[m3]: ../migrations/activity/0003_threads.sql
[adopt-doc]: ../docs/activity-adoption.md

## Toolkit status (2026-11-18)

Gaps above, as resolved in thrds `ts` (`b1a1731`, `a6a190c`). Pin `"github:Open-Athena/thrds#30c4ecf"` (`ts-dist` = `0.2.0-dist.0d6869f`) or later, or `@open-athena/thrds@^0.2.0` once tagged. The `4f6e8e0` build cited above predates these fixes. The prerequisite (G1, G4, G5) has landed.

| # | Status |
|---|---|
| G1 | Done: a definite refusal clears `pending`. |
| G2 | Done: `recover: "scan-or-post"` gives at-least-once (today's auth behaviour) when the scan can't run, and reports it as an `UNRESOLVED` action. The README now documents the history scopes; the "no Slack reads" line is gone. |
| G3 | Done: `maxRetryWaitMs` / `deadlineMs` fail fast instead of sleeping past the lease. The lease is also renewed before each write, when the store supports it. |
| G4 | Done: `post` throws `invalid_response` on a reply without `ts`. |
| G5 | Done: `SlackApiError.kind` (`slack` / `http` / `timeout` / `transport`), `slackCode` (only if it looks like a Slack code), a message built from sanitized parts, and `definite`. |
| G6 | Done: `onGone: "repost" \| "forget" \| "throw"`; `forget` reports `GONE`. |
| G7 | Done: edits no longer save each time; hashes are flushed once per run (posts still write ahead). |
| G8 | Partly: the existence check uses `client.message(ts)` (`limit: 1`). Reads still resolve `auth.test` once per client family. |
| G9 | Done: `bound(text, max, { atLine: true })` (code points, cut at `\n…`); `link` encodes `<`. |
| G10 | Done: `post` caps `username`. |
| G11 | Done: `oneKeyStore({ get, put })` for the one-key adapter, and a `default` export condition. |

## While migrating: toolkit gaps go back to thrds

Work against the pinned dist SHA; `@open-athena/thrds@^0.2.0` on npm comes only after every consumer runs on a dist SHA. If the toolkit is missing something or gets something wrong, don't patch `node_modules` or fork its code here. Write `specs/<this-project>-<topic>.md` in the thrds TS worktree (`~/c/thrds/wt/ts/specs/`) with the case and a repro (a `fakeChannel` test is ideal); the thrds session fixes it and pushes a new `ts-dist` SHA to bump to. A small local workaround meanwhile is fine; list it in this spec so it gets removed later.
