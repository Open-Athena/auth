# Link-preview bots: don't redeem, count them separately, show what they were

Requested from `jobs` on 2026-11-15.

## What happened

Ryan minted an `anon` link for Hilary Mason and pasted its per-JD URLs into Slack (to himself) before emailing them. The card then showed **4 redemptions, 4 distinct clients, "widely opened", 0 views**, and she hadn't clicked anything. `access_log` (prod `AUTH_DB`, 2026-11-15):

```
15:16:00 redeem /             Ashburn  Amazon.com, Inc.                       Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)
15:21:17 redeem /dir-eng-sf   Ashburn  Amazon Technologies Inc.               Slackbot-LinkExpanding 1.0
15:21:17 redeem /eng-mgr-nyc  Ashburn  Amazon Data Services Northern Virginia Slackbot-LinkExpanding 1.0
15:21:17 redeem /sre          Ashburn  Amazon.com, Inc.                       Slackbot-LinkExpanding 1.0
```

Every unfurl redeemed the key, minted a session no human will ever use, and counted toward `redeems` (so a link with `max_redeems` would be used up by Slack, Gmail, iMessage or Outlook previews before the recipient clicks). It also made the "widely opened" warning fire, and it'll make the Slack activity feed report a visit that wasn't one.

## Ask

1. **Recognize preview bots** in the redeem path, from a maintained list of user-agent patterns, exported so apps can extend it: Slackbot-LinkExpanding, Slack-ImgProxy, facebookexternalhit, Facebot, Twitterbot, LinkedInBot, Discordbot, TelegramBot, WhatsApp, Applebot / iMessage previews, Google-PageRenderer / GoogleImageProxy (Gmail), Microsoft Office / SkypeUriPreview / Outlook (incl. Safe Links scanners), Mimecast/Proofpoint/Barracuda-style mail scanners, Embedly, Iframely, generic `bot|crawler|spider|preview` as a last resort. Keep it a pure function (`previewBot(ua) → name | null`) with tests per pattern.
2. **A bot fetching `?key=` doesn't redeem**: no session, no `redeems` increment, no `first_used_at`, no "widely opened" contribution, not counted against `max_redeems`. It gets a preview response instead (below), and the key stays in the URL so the human's click still redeems.
3. **Preview response**: an app hook `linkPreview(req, grant) → { title, description?, image? } | null`, rendered as a minimal HTML page with OG/Twitter tags and `noindex`. Default (no hook): the app name only, no scope titles, since a preview can land in a channel the recipient didn't choose. `jobs` will return the JD title for a single-JD path ("West Coast Director of Engineering · Open Athena") and a generic title for `/`.
4. **Log it as its own event**: `access_log.event = 'preview'` with `reason = <bot name>`, so it's visible but separate. `GrantCard` stats show it apart from redemptions: e.g. "redemptions 0 · previews 4 (Slack)". The activity feed treats `preview` as its own kind (apps choose whether to notify; `jobs` will record but not post, or post as a low-key line).
5. **Mail scanners that click links** (Safe Links, Proofpoint) sometimes use browser-like UAs; can't catch all of them. Mitigation worth considering: a redemption whose session never makes a second request within N minutes is flagged "probably automated" in stats (not undone), and `max_redeems` documentation should mention it.
6. **Backfill**: existing `redeem` rows whose UA matches a bot pattern are shown as previews in stats (compute at read time, or a one-off migration that rewrites `event` and decrements `grants.redeems`; prefer read-time so nothing is rewritten).

## What `jobs` will do after this lands

Pass `linkPreview` (JD title per path), choose the `preview` kind's notify level, bump the dist; Hilary's link should then read 0 redemptions, 4 previews.
