# Grant links beside their scope rows, and a first-class "copy just the key"

Requested from `jobs` on 2026-11-15, after adopting dist `f6e26df` (`buildLink` → `{ label, url }[]`).

## 1. Per-scope links on the scope rows

Ryan's ask, looking at a freshly minted `GrantCard`: the per-page links should sit next to the scope checkboxes they belong to, not in a separate box below. Today `jobs` passes one entry per JD, and they render as a second list that repeats the JD titles already shown in the scope list above.

- Add an optional `scope?: string` to `GrantLinkEntry`. While the token is on screen (after mint or Rotate), `GrantCard` shows an entry with `scope` beside that scope's checkbox row (read-only URL or a compact Copy button, with the URL available on hover/focus), and only the entries without `scope` (e.g. the index page, the bare key) stay in the box below, with "Copy all".
- When a scope is checked while the token is still on screen, re-run `buildLink` so its link appears; when it is unchecked, its link goes away.
- Entries without `scope` behave as today, so apps that don't set it see no change.

## 2. Copy just the `?key=…` suffix

Ryan wants to paste the key onto URLs he writes himself (e.g. in an email, or deep links to sections). `jobs` currently does this with an entry `{ label: 'Just the key', url: '?key=…' }`, which works but is a hack: it's shown as if it were a URL.

- Either a built-in "Copy key" button in `GrantLink` (copies `?key=<token>` using the same param name as `shareUrl`), or a documented `kind: 'key'` entry. A built-in button seems simpler: every app with share links wants this.
- "Copy all" should leave it out, or list it last as `Key: ?key=…`.

## What `jobs` will do after this lands

Set `scope` on its per-JD entries; drop its "Just the key" entry in favor of the built-in; bump the dist.
